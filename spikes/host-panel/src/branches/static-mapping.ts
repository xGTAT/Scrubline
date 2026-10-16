import { parse } from 'parse5';
import type { Checkpoint } from '../bridge/timeline';
import { HistoryStore, safePath } from '../store/store';

export const SECTION_TAGS = new Set(['nav', 'footer', 'header', 'section', 'aside', 'article']);

export const APPROVED_TAGS = new Set([
  'html',
  'head',
  'body',
  'meta',
  'title',
  'link',
  'nav',
  'footer',
  'header',
  'section',
  'aside',
  'article',
  'main',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'img',
  'div',
  'figure',
  'figcaption',
  'blockquote',
  'time',
  'address',
  'ol',
  'ul',
  'li',
  'a',
  'span',
  'strong',
  'em',
  'small',
  'button'
]);

// Conservative prototype: a single standalone semantic section document and its unique stylesheet.
// Embedded regions, scripts, shared selectors, external styles and framework components are refused.
export async function staticSectionPaths(
  store: HistoryStore,
  checkpoint: Checkpoint,
  document: string
) {
  if (!safePath(document) || !document.endsWith('.html'))
    throw new Error('Only standalone static HTML supported.');
  const entry = checkpoint.files.find((f) => f.path === document);
  if (!entry) throw new Error('Document not tracked.');
  const html = (await store.readBlob(entry.hash)).toString('utf8');
  const tree = parse(html);
  const found: {
    tagName?: string;
    attrs?: { name: string; value: string }[];
    childNodes?: unknown[];
  }[] = [];
  function visit(node: unknown) {
    const n = node as (typeof found)[number];
    found.push(n);
    for (const c of n.childNodes ?? []) visit(c);
  }
  visit(tree);
  const nodes = found.filter((n) => n.tagName);
  if (
    nodes.some(
      (n) =>
        !APPROVED_TAGS.has(n.tagName!) ||
        n.attrs?.some((a) => a.name.startsWith('on') || a.name === 'style')
    )
  )
    throw new Error('Ambiguous static ownership blocked.');
  const sections = nodes.filter((n) => SECTION_TAGS.has(n.tagName!));
  if (
    sections.length !== 1 ||
    nodes.some((n) => ['script', 'iframe', 'style'].includes(n.tagName!))
  )
    throw new Error('Ambiguous element ownership. Use exact files.');
  const rootTag = sections[0].tagName!;
  const body = nodes.find((n) => n.tagName === 'body');
  if (
    body?.childNodes?.some((node) => {
      const n = node as (typeof found)[number];
      return !!n.tagName && n.tagName !== rootTag && n.tagName !== 'link';
    })
  )
    throw new Error('Embedded element ownership blocked.');
  const links = nodes.filter((n) => n.tagName === 'link');
  if (links.length > 1) throw new Error('Shared styles blocked.');
  const paths = [document];
  for (const link of links) {
    const href = link.attrs?.find((a) => a.name === 'href')?.value;
    const rel = link.attrs?.find((a) => a.name === 'rel')?.value;
    if (
      rel !== 'stylesheet' ||
      !href ||
      !safePath(href) ||
      href.includes('/') ||
      !href.endsWith('.css')
    )
      throw new Error('External or shared styles blocked.');
    const prefix = document.includes('/') ? document.slice(0, document.lastIndexOf('/') + 1) : '';
    const cssPath = prefix + href;
    const css = checkpoint.files.find((f) => f.path === cssPath);
    if (!css) throw new Error('Stylesheet not tracked.');
    for (const file of checkpoint.files.filter(
      (f) =>
        f.path !== document &&
        f.path !== cssPath &&
        /\.(html|js|jsx|ts|tsx|css|vue|svelte)$/.test(f.path)
    )) {
      if ((await store.readBlob(file.hash)).toString().includes(href))
        throw new Error('Shared CSS blocked.');
    }
    const text = (await store.readBlob(css.hash)).toString();
    if (/@|url\(|:root|\*|\\/i.test(text)) throw new Error('Ambiguous CSS blocked.');
    const selectorRegex = new RegExp(`^${rootTag}(?:\\s+\\.[a-zA-Z][\\w-]*)?$`);
    for (const rule of text.split('}').filter((r) => r.trim())) {
      if (rule.split('{').length !== 2) throw new Error('Invalid CSS blocked.');
      const selector = rule.split('{')[0].trim();
      if (!selectorRegex.test(selector)) throw new Error('Shared CSS selector blocked.');
    }
    paths.push(cssPath);
  }
  return paths;
}

export async function staticNavbarPaths(
  store: HistoryStore,
  checkpoint: Checkpoint,
  document: string
) {
  return staticSectionPaths(store, checkpoint, document);
}
