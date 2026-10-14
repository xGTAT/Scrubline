import { adapter } from 'parse5-htmlparser2-tree-adapter';
import { selectAll } from 'css-select';
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
  function inspect(html: string, sourceIdentity?: string, sourcePath?: number[]) {
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
    const atPath = (indices: number[]) => {
      let target = nodes.find((n) => n.tagName === 'body');
      for (const index of indices) target = target?.childNodes?.filter((n) => n.tagName)[index];
      return target;
    };
    if (elementPath) {
      const target = atPath(elementPath);
      if (!sourceIdentity) matches = target ? [target] : [];
      else {
        const sourceNode = JSON.parse(sourceIdentity) as unknown[];
        const attrs = sourceNode[1] as { name: string; value: string }[];
        const uniqueId = attrs?.find((a) => a.name === 'id')?.value;
        matches = uniqueId
          ? nodes.filter((n) => n.attrs?.some((a) => a.name === 'id' && a.value === uniqueId))
          : nodes.filter((n) => n.tagName && identity(n) === sourceIdentity);
        if (
          matches.length > 1 &&
          target &&
          identity(target) === sourceIdentity &&
          sourcePath &&
          JSON.stringify(sourcePath) === JSON.stringify(elementPath)
        ) {
          // Repeated cards/headings may use a positional address only when every
          // element identity in the document is unchanged. Inserts/reorders fail.
          const structure = nodes.filter((n) => n.tagName).map(identity);
          if (JSON.stringify(structure) === sourceStructure) matches = [target];
        }
      }
    }
    if (matches.length !== 1)
      throw new Error(
        `Cannot map the selected <${elementPath ? (atPath(elementPath)?.tagName ?? 'missing') : '#' + id}> into current source: found ${matches.length} matching elements. The page structure or identifying attributes changed. Review the whole file instead.`
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
      structure: JSON.stringify(nodes.filter((n) => n.tagName).map(identity)),
      identity: identity(node)
    };
  }
  const old = inspect(oldHtml);
  const sourceStructure = old.structure;
  const now = inspect(nowHtml, elementPath ? old.identity : undefined, elementPath);
  if (JSON.stringify(old.links) !== JSON.stringify(now.links))
    throw new Error('Stylesheet list changed. Element ownership unresolved.');
  const changes = new Map<string, string>();
  changes.set(
    document,
    nowHtml.slice(0, now.start) + oldHtml.slice(old.start, old.end) + nowHtml.slice(now.end)
  );
  inspect(changes.get(document)!, elementPath ? old.identity : undefined, elementPath); // Refuse ids introduced by the restored subtree colliding with current markup.
  for (const href of old.links) {
    const p = path.posix.join(path.posix.dirname(document), href);
    if (!safePath(p)) throw new Error('Unsafe stylesheet.');
    const before = postcss.parse(await read(source, p)),
      after = postcss.parse(await read(current, p));
    function split(root: postcss.Root, info: ReturnType<typeof inspect>, html: string) {
      const tree = parse(html, { treeAdapter: adapter, sourceCodeLocationInfo: true });
      const elements = selectAll('*', tree);
      const selected = new Set(
        elements.filter((n) => {
          const l = n.sourceCodeLocation;
          return l && l.startOffset >= info.start && l.endOffset <= info.end;
        })
      );
      const owned: postcss.Rule[] = [];
      root.walkRules((rule) => {
        let parent = rule.parent;
        while (parent && parent.type !== 'root') {
          if (
            parent.type !== 'atrule' ||
            !['media', 'supports', 'container', 'layer'].includes(parent.name.toLowerCase())
          )
            return;
          parent = parent.parent;
        }
        // Dynamic pseudo states do not narrow ownership. All potential targets
        // must be inside the selected source subtree, regardless of hover/focus.
        if (
          /:(?:not|is|where|has)\([^)]*:(?:hover|focus|active|visited|checked|disabled|enabled|target)/.test(
            rule.selector
          )
        )
          return;
        const selector = rule.selector
          .replace(/::[\w-]+(?:\([^)]*\))?/g, '')
          .replace(
            /:(?:hover|active|focus-visible|focus-within|focus|visited|link|checked|disabled|enabled|target)\b/g,
            ''
          );
        let matched;
        try {
          matched = selectAll(selector, tree);
        } catch {
          return;
        }
        if (matched.length && matched.every((n) => selected.has(n))) owned.push(rule);
      });
      const key = (r: postcss.Rule) => {
        const parents: string[] = [];
        let p = r.parent;
        while (p && p.type !== 'root') {
          if (p.type === 'atrule') parents.unshift('@' + p.name + ' ' + p.params);
          p = p.parent;
        }
        return JSON.stringify([...parents, r.selector]);
      };
      const shared = root.clone();
      const keys = owned.map(key);
      let index = 0;
      // Replace owned declarations with a marker, retaining rule position,
      // selector and conditional ancestry to preserve cascade semantics.
      shared.walkRules((r) => {
        if (keys.includes(key(r))) {
          r.removeAll();
          r.append(postcss.comment({ text: 'scrubline-owned-' + index++ }));
        }
      });
      return { owned, keys, shared: shared.toString() };
    }
    const a = split(before, old, oldHtml),
      b = split(after, now, nowHtml);
    if (a.shared !== b.shared)
      throw new Error(
        `Shared or unsupported CSS changed in ${p}. Only rules exclusive to the selected subtree can be restored; review this file instead.`
      );
    if (JSON.stringify(a.keys) !== JSON.stringify(b.keys))
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
