import * as fs from 'node:fs/promises';
import { parse } from 'parse5';
import postcss from 'postcss';
import * as path from 'node:path';
import { HistoryStore, hashBytes, atomicWrite, safePath } from '../store/store';
import type { Checkpoint } from '../bridge/timeline';
interface HtmlNode {
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  sourceCodeLocation?: {
    startOffset: number;
    endOffset: number;
    startTag?: unknown;
    endTag?: unknown;
  } | null;
}
// Plain HTML with explicit ownership. Never infer framework or shared-style ownership.
export async function elementCandidate(
  store: HistoryStore,
  source: Checkpoint,
  current: Checkpoint,
  document: string,
  id: string,
  elementPath?: number[]
) {
  if (
    !safePath(document) ||
    !document.endsWith('.html') ||
    (!elementPath && !/^[A-Za-z][\w-]*$/.test(id))
  )
    throw new Error('Choose a tracked HTML document and a simple unique element id.');
  const read = async (cp: Checkpoint, p: string) => {
    const f = cp.files.find((f) => f.path === p);
    if (!f) throw new Error('Source file unavailable.');
    return (await store.readBlob(f.hash)).toString('utf8');
  };
  const oldHtml = await read(source, document),
    nowHtml = await read(current, document);
  function inspect(html: string, sourceIdentity?: string) {
    const root = parse(html, { sourceCodeLocationInfo: true });
    const nodes: HtmlNode[] = [];
    const visit = (n: HtmlNode) => {
      nodes.push(n);
      for (const c of n.childNodes ?? []) visit(c);
    };
    visit(root);
    const parents = new Map<HtmlNode, HtmlNode>();
    for (const n of nodes) for (const c of n.childNodes ?? []) parents.set(c, n);
    const identity = (n: HtmlNode): string =>
      JSON.stringify([
        n.tagName,
        n.attrs
          ?.filter((a) => ['id', 'class', 'href', 'name', 'role', 'data-testid'].includes(a.name))
          .sort((a, b) => a.name.localeCompare(b.name)),
        parents.get(n)?.tagName === 'body'
          ? undefined
          : parents.get(n)?.tagName
            ? identity(parents.get(n)!)
            : undefined
      ]);
    let matches = nodes.filter((n) => n.attrs?.some((a) => a.name === 'id' && a.value === id));
    if (elementPath) {
      if (sourceIdentity)
        matches = nodes.filter((n) => n.tagName && identity(n) === sourceIdentity);
      else {
        let target = nodes.find((n) => n.tagName === 'body');
        for (const index of elementPath)
          target = target?.childNodes?.filter((n) => n.tagName)[index];
        matches = target ? nodes.filter((n) => n.tagName && identity(n) === identity(target!)) : [];
      }
    }
    if (matches.length !== 1)
      throw new Error(
        'Element id must appear exactly once or selection must map uniquely in both documents.'
      );
    const node = matches[0],
      loc = node.sourceCodeLocation;
    if (
      !loc?.startTag ||
      (!loc.endTag &&
        !['img', 'input', 'br', 'hr', 'area', 'source', 'wbr', 'embed', 'track', 'col'].includes(
          node.tagName ?? ''
        )) ||
      ['html', 'head', 'body', 'script', 'style', 'iframe', 'link'].includes(node.tagName ?? '')
    )
      throw new Error('Choose an ordinary complete HTML element.');
    const ids = nodes.flatMap(
      (n) => n.attrs?.filter((a) => a.name === 'id').map((a) => a.value) ?? []
    );
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate ids in document.');
    const selected: HtmlNode[] = [];
    const gather = (n: HtmlNode) => {
      selected.push(n);
      for (const c of n.childNodes ?? []) gather(c);
    };
    gather(node);
    if (
      nodes.some((n) => n.tagName === 'script') ||
      selected.some(
        (n) =>
          ['script', 'style', 'iframe', 'link', 'object'].includes(n.tagName ?? '') ||
          n.attrs?.some((a: { name: string; value: string }) => /^on/i.test(a.name))
      )
    )
      throw new Error('Scripted or active HTML unsupported.');
    const links = nodes
      .filter(
        (n) =>
          n.tagName === 'link' &&
          n.attrs?.some(
            (a: { name: string; value: string }) => a.name === 'rel' && a.value === 'stylesheet'
          )
      )
      .map((n) => n.attrs!.find((a: { name: string; value: string }) => a.name === 'href')?.value);
    if (links.some((h) => typeof h !== 'string' || !safePath(h) || !h.endsWith('.css')))
      throw new Error('Use local relative CSS files without query strings.');
    if (nodes.some((n) => n.tagName === 'style'))
      throw new Error('Embedded style sheets unsupported; use inline styles or local CSS.');
    return {
      start: loc.startOffset,
      end: loc.endOffset,
      links: links as string[],
      node,
      nodes,
      selected,
      identity: identity(node)
    };
  }
  const old = inspect(oldHtml),
    now = inspect(nowHtml, elementPath ? old.identity : undefined);
  if (JSON.stringify(old.links) !== JSON.stringify(now.links))
    throw new Error('Stylesheet list changed. Element ownership unresolved.');
  const changes = new Map<string, string>();
  changes.set(
    document,
    nowHtml.slice(0, now.start) + oldHtml.slice(old.start, old.end) + nowHtml.slice(now.end)
  );
  inspect(changes.get(document)!, elementPath ? old.identity : undefined); // Refuse ids introduced by the restored subtree colliding with current markup.
  for (const href of old.links) {
    const p = path.posix.join(path.posix.dirname(document), href);
    if (!safePath(p)) throw new Error('Unsafe stylesheet.');
    const before = postcss.parse(await read(source, p)),
      after = postcss.parse(await read(current, p));
    function split(root: postcss.Root, info: ReturnType<typeof inspect>) {
      const owned: postcss.Rule[] = [];
      root.walkAtRules(() => {
        throw new Error('CSS at-rules unsupported.');
      });
      root.walkDecls((d) => {
        if (d.prop.startsWith('--') || /var\(|url\(/i.test(d.value))
          throw new Error('Shared tokens/URLs unsupported.');
      });
      const parents = new Map<HtmlNode, HtmlNode>();
      for (const n of info.nodes) for (const child of n.childNodes ?? []) parents.set(child, n);
      const simple = (n: HtmlNode, s: string) => {
        const m = /^([a-zA-Z][\w-]*)?(#[\w-]+)?((?:\.[\w-]+)*)$/.exec(s);
        if (!m) return false;
        return (
          (!m[1] || n.tagName === m[1]) &&
          (!m[2] || n.attrs?.some((a) => a.name === 'id' && '#' + a.value === m[2])) &&
          m[3]
            .split('.')
            .filter(Boolean)
            .every((c) =>
              n.attrs?.some((a) => a.name === 'class' && a.value.split(/\s+/).includes(c))
            )
        );
      };
      const matches = (n: HtmlNode, s: string) => {
        const bits = s.trim().split(/\s+/);
        let cursor: HtmlNode | undefined = n;
        if (!simple(n, bits.pop()!)) return false;
        while (bits.length) {
          const bit = bits.pop()!;
          cursor = parents.get(cursor!);
          while (cursor && !simple(cursor, bit)) cursor = parents.get(cursor);
          if (!cursor) return false;
        }
        return true;
      };
      root.walkRules((rule) => {
        if (!rule.selector.split(',').every((s) => /^[\w# .-]+$/.test(s)))
          throw new Error('Complex CSS selector ownership unsupported.');
        const matched = info.nodes.filter(
          (n) => n.tagName && rule.selector.split(',').some((s) => matches(n, s))
        );
        if (matched.length && matched.every((n) => info.selected.includes(n))) owned.push(rule);
      });
      const shared = root.clone();
      shared.walkRules((r) => {
        if (owned.some((o) => o.selector === r.selector)) r.remove();
      });
      return { owned, shared: shared.toString() };
    }
    const a = split(before, old),
      b = split(after, now);
    if (a.shared !== b.shared)
      throw new Error('Shared CSS differs. Cannot cherry-pick styling safely. Use file review.');
    if (
      JSON.stringify(a.owned.map((r) => r.selector)) !==
      JSON.stringify(b.owned.map((r) => r.selector))
    )
      throw new Error('Owned CSS selector order changed. Use file review.');
    for (let i = 0; i < b.owned.length; i++) b.owned[i].replaceWith(a.owned[i].clone());
    changes.set(p, after.toString());
  }
  const files = current.files.map((f) => ({ ...f }));
  for (const [p, text] of changes) {
    const f = files.find((f) => f.path === p)!;
    const bytes = Buffer.from(text);
    f.hash = hashBytes(bytes);
    f.size = bytes.length;
    let used = 0;
    for (const dir of ['blobs', 'manifests'])
      for (const name of await fs.readdir(path.join(store.root, dir)))
        used += (await fs.stat(path.join(store.root, dir, name))).size;
    if (used + bytes.length > store.quotaBytes) throw new Error('Storage limit reached.');
    await atomicWrite(path.join(store.root, 'blobs', f.hash), bytes);
  }
  const { id: _id, ...body } = current;
  void _id;
  const candidate = { ...body, files };
  return { ...candidate, id: hashBytes(JSON.stringify(candidate)) };
}
