// JSX/TSX static element indexing via @babel/parser. Covers React, Preact,
// Solid, Next.js and other JSX-based stacks. No build, no node_modules.
import { parse } from '@babel/parser';
import type { SourceElement, SourceIndex } from './types';

interface BabelNode {
  type: string;
  start?: number | null;
  end?: number | null;
  name?: string;
  value?: unknown;
  [key: string]: unknown;
}

const STYLE_IMPORT =
  /(?:import\s+(?:[^'"]*\sfrom\s+)?|require\()\s*['"]([^'"]+\.(?:css|scss|less))['"]/g;
const CSS_IN_JS = /from\s+['"](styled-components|@emotion\/[^'"]+)['"]/;
const SKIP_KEYS = new Set([
  'start',
  'end',
  'loc',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'extra'
]);

function jsxTag(opening: BabelNode): string {
  const nameNode = opening.name as unknown as BabelNode;
  if (nameNode.type === 'JSXIdentifier') return nameNode.name as string;
  if (nameNode.type === 'JSXMemberExpression')
    return ((nameNode.property as BabelNode).name as string) ?? 'Member';
  return 'Fragment';
}

export function indexJsx(file: string, code: string): SourceIndex {
  const ast = parse(code, {
    sourceType: 'module',
    allowImportExportEverywhere: true,
    errorRecovery: false,
    plugins: ['jsx', 'typescript']
  });
  const elements: SourceElement[] = [];
  const visit = (node: BabelNode, ancestors: string[], dynamic: boolean, parent = -1) => {
    let nextAncestors = ancestors;
    let nextParent = parent;
    let nextDynamic = dynamic;
    if (
      node.type === 'CallExpression' ||
      node.type === 'ConditionalExpression' ||
      node.type === 'LogicalExpression'
    )
      nextDynamic = true;
    if (node.type === 'JSXElement') {
      const opening = node.openingElement as BabelNode;
      const rawTag = jsxTag(opening);
      const component = /^[A-Z]/.test(rawTag);
      const tag = component ? rawTag : rawTag.toLowerCase();
      const attrs: Record<string, string> = {};
      let spread = false;
      for (const attr of (opening.attributes as BabelNode[]) ?? []) {
        if (attr.type === 'JSXSpreadAttribute') {
          spread = true;
          continue;
        }
        if (attr.type !== 'JSXAttribute') continue;
        const key = (attr.name as unknown as BabelNode).name as string;
        const value = attr.value as BabelNode | null | undefined;
        let text: string | undefined;
        if (value?.type === 'StringLiteral') text = value.value as string;
        else if (
          value?.type === 'JSXExpressionContainer' &&
          (value.expression as BabelNode | undefined)?.type === 'StringLiteral'
        )
          text = (value.expression as BabelNode).value as string;
        if (typeof text === 'string') attrs[key] = text;
      }
      const texts: string[] = [];
      let exprDynamic = false;
      for (const child of (node.children as BabelNode[]) ?? []) {
        if (child.type === 'JSXText') {
          const t = String(child.value ?? '')
            .replace(/\s+/g, ' ')
            .trim();
          if (t) texts.push(t);
        } else if (child.type === 'JSXExpressionContainer') {
          const expr = child.expression as BabelNode | undefined;
          if (expr?.type === 'StringLiteral') texts.push(expr.value as string);
          else exprDynamic = true;
        }
      }
      const classAttr = attrs['className'] ?? attrs['class'] ?? '';
      elements.push({
        file,
        start: node.start!,
        end: node.end!,
        tag,
        component,
        id: attrs['id'],
        testId: attrs['data-testid'],
        classes: classAttr.split(/\s+/).filter(Boolean),
        href: attrs['href'],
        name: attrs['aria-label'],
        text: texts.join(' ').slice(0, 300),
        ancestors: [...ancestors],
        parent,
        dynamic: nextDynamic || spread || exprDynamic
      });
      nextAncestors = [...ancestors, tag];
      nextParent = elements.length - 1;
    }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child === 'object' && (child as BabelNode).type)
            visit(child as BabelNode, nextAncestors, nextDynamic, nextParent);
      } else if (value && typeof value === 'object' && (value as BabelNode).type) {
        visit(value as BabelNode, nextAncestors, nextDynamic, nextParent);
      }
    }
  };
  visit(ast as unknown as BabelNode, [], false);
  const stylesheets: string[] = [];
  for (const match of code.matchAll(STYLE_IMPORT)) {
    if (match[1].startsWith('.')) stylesheets.push(match[1]);
  }
  return { file, elements, stylesheets, styleBlocks: [], cssInJs: CSS_IN_JS.test(code) };
}
