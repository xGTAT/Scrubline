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
  const values = new Map<
    string,
    { value: string; selector: string; property: string; supported: boolean; duplicate?: boolean }
  >();
  const occurrences = new Map<string, number>();
  const nodes = new Map<postcss.Declaration, string>();
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
      if (node.type !== 'decl') throw new Error('Nested CSS unsupported.');
      const baseKey = [...context, rule.selector, node.prop].join('\0');
      const count = occurrences.get(baseKey) ?? 0;
      occurrences.set(baseKey, count + 1);
      const key = count ? `${baseKey}\0${count}` : baseKey;
      if (count) values.get(baseKey)!.duplicate = true;
      nodes.set(node, key);
      values.set(key, {
        value: node.value + (node.important ? ' !important' : ''),
        selector: rule.selector,
        property: node.prop,
        supported: !node.prop.startsWith('--') && !/var\(|url\(/i.test(node.value),
        duplicate: count > 0
      });
    }
  });
  return { root, values, nodes };
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
    .map(([key, value]) => {
      if (value.duplicate || b.values.get(key)!.duplicate)
        throw new Error('Duplicate CSS ownership.');
      if (!value.supported || !b.values.get(key)!.supported)
        throw new Error(
          'Shared tokens or URLs changed; value-only investigation requires independent declarations.'
        );
      return {
        key,
        path,
        selector: value.selector,
        property: value.property,
        before: value.value,
        after: b.values.get(key)!.value
      };
    });
}
export function applyUnits(before: string, units: readonly CssUnit[]) {
  const { root, values, nodes } = index(before);
  const chosen = new Map(units.map((u) => [u.key, u]));
  for (const [decl, key] of nodes) {
    const unit = chosen.get(key);
    if (!unit) continue;
    const metadata = values.get(key)!;
    if (metadata.duplicate) throw new Error('Duplicate CSS ownership.');
    if (!metadata.supported || unit.property.startsWith('--') || /var\(|url\(/i.test(unit.after))
      throw new Error('Shared tokens or URLs unsupported.');
    const current = decl.value + (decl.important ? ' !important' : '');
    if (current !== unit.before) throw new Error('CSS base identity mismatch.');
    decl.important = unit.after.endsWith(' !important');
    decl.value = unit.after.replace(/ !important$/, '');
    chosen.delete(key);
  }
  if (chosen.size) throw new Error('CSS declaration identity unavailable.');
  return root.toString();
}
