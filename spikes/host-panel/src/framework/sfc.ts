// Single-file-component indexing for Vue (.vue), Astro (.astro) and Svelte
// (.svelte). Templates are parsed as HTML after masking `{...}` / control
// expressions with same-length placeholders so byte offsets stay exact.
import { parse } from 'parse5';
import type { SourceElement, SourceIndex } from './types';

interface HtmlNode {
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  sourceCodeLocation?: { startOffset: number; endOffset: number } | null;
}

// Replace balanced {...} expression contents with spaces (offsets preserved).
export function maskExpressions(code: string): string {
  const chars = code.split('');
  let depth = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '{') {
      depth++;
      chars[i] = ' ';
      continue;
    }
    if (c === '}') {
      if (depth > 0) {
        depth--;
        chars[i] = ' ';
      }
      continue;
    }
    if (depth > 0 && c !== '\n') chars[i] = ' ';
  }
  return chars.join('');
}

interface Block {
  name: string;
  attrs: { name: string; value: string }[];
  start: number; // offset of '<name'
  end: number; // offset just past '</name>' or self-close
  contentStart: number;
  contentEnd: number;
}

// Find top-level blocks (template/script/style/frontmatter) by scanning raw text.
// Nested same-name tags inside a block are not supported (refused by caller when
// they would corrupt ranges).
function topBlocks(code: string, names: string[]): Block[] {
  const blocks: Block[] = [];
  const re = /<(template|script|style)(\s[^>]*)?(\/?)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const name = m[1].toLowerCase();
    if (!names.includes(name)) continue;
    if (blocks.some((b) => b.name === name)) continue; // first block wins; extras ignored
    const openEnd = m.index + m[0].length;
    if (m[3] === '/') {
      blocks.push({
        name,
        attrs: parseAttrs(m[2] ?? ''),
        start: m.index,
        end: openEnd,
        contentStart: openEnd,
        contentEnd: openEnd
      });
      continue;
    }
    const close = new RegExp(`</${name}\\s*>`, 'i');
    const rest = code.slice(openEnd);
    const cm = close.exec(rest);
    if (!cm) continue;
    blocks.push({
      name,
      attrs: parseAttrs(m[2] ?? ''),
      start: m.index,
      end: openEnd + cm.index + cm[0].length,
      contentStart: openEnd,
      contentEnd: openEnd + cm.index
    });
  }
  return blocks;
}

function parseAttrs(raw: string): { name: string; value: string }[] {
  const attrs: { name: string; value: string }[] = [];
  const re = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) attrs.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] ?? '' });
  return attrs;
}

export function indexTemplate(file: string, html: string, offset: number): SourceElement[] {
  const root = parse(html, { sourceCodeLocationInfo: true });
  const elements: SourceElement[] = [];
  const visit = (n: HtmlNode, ancestors: string[], parent = -1) => {
    if (n.tagName && n.sourceCodeLocation) {
      const attrs = Object.fromEntries((n.attrs ?? []).map((a) => [a.name, a.value]));
      const texts: string[] = [];
      for (const c of n.childNodes ?? []) {
        const t = (c as unknown as { value?: string }).value;
        if (typeof t === 'string') {
          const norm = t.replace(/\s+/g, ' ').trim();
          if (norm) texts.push(norm);
        }
      }
      const tag = n.tagName.toLowerCase();
      const classAttr = attrs['class'] ?? '';
      const directiveAttrs = (n.attrs ?? []).some((a) => /^(?:on[:.]|[@:#*]|\[|\()/.test(a.name));
      elements.push({
        file,
        start: offset + n.sourceCodeLocation.startOffset,
        end: offset + n.sourceCodeLocation.endOffset,
        tag,
        component: false,
        id: attrs['id'],
        testId: attrs['data-testid'],
        classes: classAttr.split(/\s+/).filter(Boolean),
        href: attrs['href'],
        name: attrs['aria-label'],
        text: texts.join(' ').slice(0, 300),
        ancestors: [...ancestors],
        parent,
        dynamic: directiveAttrs
      });
      const self = elements.length - 1;
      for (const c of n.childNodes ?? []) visit(c, [...ancestors, tag], self);
      return;
    }
    for (const c of n.childNodes ?? []) visit(c, ancestors, parent);
  };
  visit(root, []);
  return elements;
}

export function indexSfc(file: string, code: string): SourceIndex {
  const lower = file.toLowerCase();
  let templateHtml: string;
  let templateOffset: number;
  let elements: SourceElement[] = [];
  let styleBlocks: SourceIndex['styleBlocks'] = [];
  if (lower.endsWith('.vue')) {
    const blocks = topBlocks(code, ['template', 'style']);
    const template = blocks.find((b) => b.name === 'template');
    if (!template) throw new Error('Vue component has no template block.');
    templateHtml = code.slice(template.contentStart, template.contentEnd);
    templateOffset = template.contentStart;
    styleBlocks = blocks
      .filter((b) => b.name === 'style')
      .map((b) => ({
        start: b.start,
        end: b.end,
        contentStart: b.contentStart,
        contentEnd: b.contentEnd
      }));
  } else if (lower.endsWith('.astro')) {
    // Frontmatter is a --- ... --- fence at the top; the rest is the template.
    let start = 0;
    if (code.startsWith('---')) {
      const fence = code.indexOf('\n---', 3);
      if (fence === -1) throw new Error('Unclosed Astro frontmatter.');
      start = code.indexOf('\n', fence + 1) + 1;
    }
    const blocks = topBlocks(code.slice(start), ['style']).map((b) => ({
      start: b.start + start,
      end: b.end + start,
      contentStart: b.contentStart + start,
      contentEnd: b.contentEnd + start
    }));
    styleBlocks = blocks;
    templateHtml = code.slice(start);
    templateOffset = start;
  } else if (lower.endsWith('.svelte')) {
    const blocks = topBlocks(code, ['script', 'style']);
    // Mask script and style blocks out of the template parse.
    const chars = code.split('');
    for (const b of blocks)
      for (let i = b.start; i < b.end; i++) if (chars[i] !== '\n') chars[i] = ' ';
    templateHtml = chars.join('');
    templateOffset = 0;
    styleBlocks = blocks
      .filter((b) => b.name === 'style')
      .map((b) => ({
        start: b.start,
        end: b.end,
        contentStart: b.contentStart,
        contentEnd: b.contentEnd
      }));
  } else {
    throw new Error('Unsupported component file.');
  }
  elements = indexTemplate(file, maskExpressions(templateHtml), templateOffset);
  return { file, elements, stylesheets: [], styleBlocks, cssInJs: false };
}
