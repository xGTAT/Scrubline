import postcss from 'postcss';
export interface CssUnit {
  key: string;
  path: string;
  selector: string;
  property: string;
  before: string;
  after: string;
}
function index(text: string) {
  const root = postcss.parse(text);
  const values = new Map<string, { value: string; selector: string; property: string }>();
  root.walkAtRules((rule) => {
    if (!['media', 'supports', 'layer'].includes(rule.name))
      throw new Error('Unsupported CSS at-rule.');
  });
  root.walkRules((rule) => {
    const context: string[] = [];
    let parent = rule.parent;
    while (parent && parent.type !== 'root') {
      if (parent.type === 'atrule') context.unshift(`@${parent.name} ${parent.params}`);
      else throw new Error('Nested selectors unsupported.');
      parent = parent.parent;
    }
    for (const node of rule.nodes) {
      if (node.type === 'comment') continue;
      if (node.type !== 'decl' || node.prop.startsWith('--') || /var\(|url\(/i.test(node.value))
        throw new Error('Shared tokens, URLs or nested CSS unsupported.');
      const key = [...context, rule.selector, node.prop].join('\0');
      if (values.has(key)) throw new Error('Duplicate CSS ownership.');
      values.set(key, {
        value: node.value + (node.important ? ' !important' : ''),
        selector: rule.selector,
        property: node.prop
      });
    }
  });
  return { root, values };
}
export function declarationChanges(path: string, before: string, after: string): CssUnit[] {
  const a = index(before),
    b = index(after);
  if (a.values.size !== b.values.size || [...a.values.keys()].some((k) => !b.values.has(k)))
    throw new Error('CSS structure changed; value-only investigation required.');
  // Ensure selector/cascade structure did not change independently of values.
  const structure = (text: string) => {
    const tree = postcss.parse(text);
    tree.walkComments((n) => {
      n.remove();
    });
    tree.walkDecls((d) => {
      d.value = '__value__';
      d.important = false;
    });
    return tree.toString().replace(/\s+/g, '');
  };
  if (structure(before) !== structure(after)) throw new Error('CSS rule order/structure changed.');
  return [...a.values]
    .filter(([key, value]) => value.value !== b.values.get(key)!.value)
    .map(([key, value]) => ({
      key,
      path,
      selector: value.selector,
      property: value.property,
      before: value.value,
      after: b.values.get(key)!.value
    }));
}
export function applyUnits(before: string, units: readonly CssUnit[]) {
  const { root } = index(before);
  const chosen = new Map(units.map((u) => [u.key, u]));
  root.walkRules((rule) => {
    const context: string[] = [];
    let parent = rule.parent;
    while (parent && parent.type !== 'root') {
      if (parent.type === 'atrule') context.unshift(`@${parent.name} ${parent.params}`);
      parent = parent.parent;
    }
    rule.walkDecls((decl) => {
      const unit = chosen.get([...context, rule.selector, decl.prop].join('\0'));
      if (!unit) return;
      const current = decl.value + (decl.important ? ' !important' : '');
      if (current !== unit.before) throw new Error('CSS base identity mismatch.');
      decl.important = unit.after.endsWith(' !important');
      decl.value = unit.after.replace(/ !important$/, '');
    });
  });
  return root.toString();
}
