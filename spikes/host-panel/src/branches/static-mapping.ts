import { parse } from 'parse5';
import type { Checkpoint } from '../bridge/timeline';
import { HistoryStore, safePath } from '../store/store';
// Conservative prototype: a single standalone navbar document and its unique stylesheet.
// Embedded regions, scripts, shared selectors, external styles and framework components are refused.
export async function staticNavbarPaths(
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
  const nav = nodes.filter((n) => n.tagName === 'nav');
  const approved = new Set([
    'html',
    'head',
    'body',
    'meta',
    'title',
    'link',
    'nav',
    'a',
    'span',
    'ul',
    'li',
    'strong',
    'em',
    'small',
    'button'
  ]);
  if (
    nodes.some(
      (n) =>
        !approved.has(n.tagName!) ||
        n.attrs?.some((a) => a.name.startsWith('on') || a.name === 'style')
    )
  )
    throw new Error('Ambiguous static ownership blocked.');
  const body = nodes.find((n) => n.tagName === 'body');
  if (
    body?.childNodes?.some((node) => {
      const n = node as (typeof found)[number];
      return !!n.tagName && !['nav', 'link'].includes(n.tagName);
    })
  )
    throw new Error('Embedded element ownership blocked.');
  if (
    nav.length !== 1 ||
    nodes.some((n) => ['footer', 'main', 'script', 'iframe', 'style'].includes(n.tagName!))
  )
    throw new Error('Ambiguous element ownership. Use exact files.');
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
    for (const rule of text.split('}').filter((r) => r.trim())) {
      if (rule.split('{').length !== 2) throw new Error('Invalid CSS blocked.');
      const selector = rule.split('{')[0].trim();
      if (!/^nav(?:\s+\.[a-zA-Z][\w-]*)?$/.test(selector))
        throw new Error('Shared CSS selector blocked.');
    }
    paths.push(cssPath);
  }
  return paths;
}
