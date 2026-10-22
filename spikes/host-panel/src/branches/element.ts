import { adapter } from 'parse5-htmlparser2-tree-adapter';
import { selectAll } from 'css-select';
import { parse, parseFragment, serialize } from 'parse5';
import postcss from 'postcss';
import * as path from 'node:path';
import { HistoryStore, hashBytes, safePath } from '../store/store';
import type { Checkpoint } from '../bridge/timeline';
interface HtmlNode {
  tagName?: string;
  namespaceURI?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  sourceCodeLocation?: {
    startOffset: number;
    endOffset: number;
    startTag?: { startOffset: number; endOffset: number };
    endTag?: { startOffset: number; endOffset: number };
  } | null;
}
// Plain HTML with explicit ownership. Never infer framework or shared-style ownership.

/**
 * Vanish guard for element reverts. A revert splices the old subtree into the
 * current document over the byte range [start, end); every element of the
 * current document outside that range must survive byte-identical in effect:
 * same ids, same per-tag element counts outside the inserted subtree. If a
 * match was ambiguous or the range swallowed siblings, this throws instead of
 * silently dropping elements (the "revert works 70%, elements vanish" bug).
 */
export function assertSplicePreserves(
  nowHtml: string,
  start: number,
  end: number,
  result: string,
  insertedLength: number
): void {
  const elementsWithIds = (html: string, from: number, to: number, invert: boolean) => {
    const root = parse(html, { sourceCodeLocationInfo: true });
    const ids: string[] = [];
    const tagCounts = new Map<string, number>();
    const visit = (n: HtmlNode) => {
      const loc = n.sourceCodeLocation;
      if (n.tagName && loc) {
        const outside = loc.endOffset <= from || loc.startOffset >= to;
        if (outside !== invert) {
          tagCounts.set(n.tagName, (tagCounts.get(n.tagName) ?? 0) + 1);
          const id = n.attrs?.find((a) => a.name === 'id')?.value;
          if (id) ids.push(id);
        }
      }
      for (const c of n.childNodes ?? []) visit(c);
    };
    visit(root);
    return { ids, tagCounts };
  };
  const before = elementsWithIds(nowHtml, start, end, false);
  const after = elementsWithIds(result, start, start + insertedLength, false);
  const missingIds = before.ids.filter((id) => !after.ids.includes(id));
  if (missingIds.length)
    throw new Error(
      `Revert refused: elements would vanish from the current document: ${missingIds
        .map((id) => `#${id}`)
        .join(', ')}.`
    );
  for (const [tag, count] of before.tagCounts) {
    const afterCount = after.tagCounts.get(tag) ?? 0;
    if (afterCount !== count)
      throw new Error(
        `Revert refused: ${count} <${tag}> element(s) outside the reverted element would become ${afterCount}.`
      );
  }
}

/**
 * Three-way revert: restore the old version of the subtree while keeping
 * elements added inside it since the old checkpoint. Children of the target
 * match by id when both sides have one, else by tag plus occurrence index
 * among same-tag siblings. Matched children revert to the old version;
 * unmatched current children are additions and are kept, appended after the
 * restored children (their position may move; they must never vanish).
 */
export function mergePreservingAdditions(oldSlice: string, nowSlice: string): string {
  const rootOf = (html: string) => {
    const doc = parse(html, { sourceCodeLocationInfo: true });
    let found: HtmlNode | undefined;
    const visit = (n: HtmlNode) => {
      if (!found && n.tagName && n.sourceCodeLocation?.startTag) found = n;
      for (const c of n.childNodes ?? []) visit(c);
    };
    visit(doc);
    return found;
  };
  const oldRoot = rootOf(oldSlice);
  const nowRoot = rootOf(nowSlice);
  const oldLoc = oldRoot?.sourceCodeLocation;
  if (!oldRoot || !oldLoc?.startTag || !oldLoc.endTag || !nowRoot) return oldSlice;

  const elementChildren = (n: HtmlNode) => (n.childNodes ?? []).filter((c) => c.tagName);
  const oldChildren = elementChildren(oldRoot);
  const nowChildren = elementChildren(nowRoot);

  const keyOf = (n: HtmlNode, siblings: HtmlNode[]): string => {
    const idAttr = n.attrs?.find((a) => a.name === 'id')?.value;
    if (idAttr) return `id:${idAttr}`;
    const sameTag = siblings.filter((s) => s.tagName === n.tagName);
    return `tag:${n.tagName}:${sameTag.indexOf(n)}`;
  };
  const oldKeys = new Set(oldChildren.map((c) => keyOf(c, oldChildren)));
  const additions = nowChildren.filter((c) => !oldKeys.has(keyOf(c, nowChildren)));
  if (!additions.length) return oldSlice;

  let additionsHtml = '';
  for (const a of additions) {
    const loc = a.sourceCodeLocation;
    if (!loc) return oldSlice; // Cannot bound an addition: refuse to merge, keep pure restore.
    additionsHtml += nowSlice.slice(loc.startOffset, loc.endOffset);
  }
  return (
    oldSlice.slice(0, oldLoc.endTag.startOffset) +
    additionsHtml +
    oldSlice.slice(oldLoc.endTag.startOffset)
  );
}

function inspectHtml(
  html: string,
  id: string,
  elementPath: number[] | undefined,
  sourceIdentity?: string,
  sourceSkeleton?: string
) {
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
        ?.filter((a) =>
          ['id', 'class', 'href', 'name', 'role', 'data-testid', 'aria-label'].includes(a.name)
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
      parents.get(n)?.tagName === 'body'
        ? undefined
        : parents.get(n)?.tagName
          ? identity(parents.get(n)!)
          : undefined
    ]);
  // Classes, href and ancestor styling are restore data, not immutable IDs.
  // Positional fallback is safe only when the whole tag/ID skeleton agrees.
  const skeleton = JSON.stringify(
    nodes
      .filter((n) => n.tagName)
      .map((n) => [n.tagName, n.attrs?.find((a) => a.name === 'id')?.value ?? ''])
  );
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
      if (matches.length !== 1 && !uniqueId) {
        // Compare semantic anchors without CSS classes on the node or ancestors.
        const semantic = (value: string): string => {
          const [tag, attrs, parent] = JSON.parse(value) as [
            string,
            { name: string; value: string }[],
            string?
          ];
          return JSON.stringify([
            tag,
            attrs?.filter((a) => a.name !== 'class'),
            parent ? semantic(parent) : undefined
          ]);
        };
        matches = nodes.filter(
          (n) => n.tagName && semantic(identity(n)) === semantic(sourceIdentity)
        );
      }
      if (
        matches.length !== 1 &&
        !uniqueId &&
        target &&
        target.tagName === sourceNode[0] &&
        skeleton === sourceSkeleton
      ) {
        matches = [target];
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
      node.namespaceURI !== 'http://www.w3.org/2000/svg' &&
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
    skeleton,
    identity: identity(node)
  };
}

async function computeElementChanges(
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
  const old = inspectHtml(oldHtml, id, elementPath);
  const now = inspectHtml(
    nowHtml,
    id,
    elementPath,
    elementPath ? old.identity : undefined,
    old.skeleton
  );
  if (JSON.stringify(old.links) !== JSON.stringify(now.links))
    throw new Error('Stylesheet list changed. Element ownership unresolved.');
  const changes = new Map<string, string>();
  const restored = mergePreservingAdditions(
    oldHtml.slice(old.start, old.end),
    nowHtml.slice(now.start, now.end)
  );
  const spliced = nowHtml.slice(0, now.start) + restored + nowHtml.slice(now.end);
  assertSplicePreserves(nowHtml, now.start, now.end, spliced, restored.length);
  changes.set(document, spliced);
  inspectHtml(
    changes.get(document)!,
    id,
    elementPath,
    elementPath ? old.identity : undefined,
    old.skeleton
  ); // Refuse ids introduced by the restored subtree colliding with current markup.
  for (const href of old.links) {
    const p = path.posix.join(path.posix.dirname(document), href);
    if (!safePath(p)) throw new Error('Unsafe stylesheet.');
    const before = postcss.parse(await read(source, p)),
      after = postcss.parse(await read(current, p));
    function split(root: postcss.Root, info: ReturnType<typeof inspectHtml>, html: string) {
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
      const keys = owned.map(key);
      return { owned, keys, key };
    }
    const a = split(before, old, oldHtml),
      b = split(after, now, nowHtml);
    // Unrelated and shared style edits stay current. Never roll them back merely
    // because they share a stylesheet with a clicked element.
    for (let i = 0; i < b.owned.length; i++) {
      const key = b.keys[i];
      const oldRules = a.owned.filter((r) => a.key(r) === key);
      const newRules = b.owned.filter((r) => b.key(r) === key);
      if (oldRules.length === 1 && newRules.length === 1)
        b.owned[i].replaceWith(oldRules[0].clone());
    }
    changes.set(p, after.toString());
  }
  return {
    changes,
    restored,
    sourceIdentity: old.identity,
    sourceSkeleton: old.skeleton,
    nowLinks: now.links
  };
}

/** Materialize changed file contents into blobs and a candidate checkpoint. */
async function materializeCandidate(
  store: HistoryStore,
  current: Checkpoint,
  changes: Map<string, string>
) {
  const files = current.files.map((f) => ({ ...f }));
  for (const [p, text] of changes) {
    const f = files.find((f) => f.path === p)!;
    const bytes = Buffer.from(text);
    f.hash = hashBytes(bytes);
    f.size = bytes.length;
    await store.putBlob(f.hash, bytes);
  }
  const { id: _id, ...body } = current;
  void _id;
  const candidate = { ...body, files };
  return { ...candidate, id: hashBytes(JSON.stringify(candidate)) };
}

export async function elementCandidate(
  store: HistoryStore,
  source: Checkpoint,
  current: Checkpoint,
  document: string,
  id: string,
  elementPath?: number[]
) {
  const { changes } = await computeElementChanges(
    store,
    source,
    current,
    document,
    id,
    elementPath
  );
  return materializeCandidate(store, current, changes);
}

/** Bound sitewide applies so a huge multi-page site stays reviewable. */
export const SITEWIDE_MAX_DOCUMENTS = 100;

/**
 * Apply one picked element change across every tracked HTML document that
 * contains the same element. The picked document's change is computed exactly
 * as a single-page restore; every other document is re-matched by the same
 * identity rules, refused documents are skipped with their reason, and the
 * shared stylesheet changes apply once. A document whose structure or
 * stylesheet list diverges is never guessed at.
 */
export async function elementCandidateAcrossDocuments(
  store: HistoryStore,
  source: Checkpoint,
  current: Checkpoint,
  document: string,
  id: string,
  elementPath: number[] | undefined,
  documents: string[]
) {
  const base = await computeElementChanges(store, source, current, document, id, elementPath);
  const changes = new Map(base.changes);
  const applied = [document];
  const skipped: { document: string; reason: string }[] = [];
  const targets = documents
    .filter((d) => d !== document && d.endsWith('.html'))
    .slice(0, SITEWIDE_MAX_DOCUMENTS);
  for (const other of targets) {
    try {
      const f = current.files.find((f) => f.path === other);
      if (!f) {
        skipped.push({ document: other, reason: 'Not in the current checkpoint.' });
        continue;
      }
      const nowHtml = (await store.readBlob(f.hash)).toString('utf8');
      const now = inspectHtml(nowHtml, id, elementPath, base.sourceIdentity, base.sourceSkeleton);
      if (JSON.stringify(now.links) !== JSON.stringify(base.nowLinks)) {
        skipped.push({
          document: other,
          reason: 'Stylesheet list differs; element ownership unresolved.'
        });
        continue;
      }
      const spliced = nowHtml.slice(0, now.start) + base.restored + nowHtml.slice(now.end);
      assertSplicePreserves(nowHtml, now.start, now.end, spliced, base.restored.length);
      inspectHtml(spliced, id, elementPath, base.sourceIdentity, base.sourceSkeleton);
      changes.set(other, spliced);
      applied.push(other);
    } catch (e) {
      skipped.push({ document: other, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  const candidate = await materializeCandidate(store, current, changes);
  return { candidate, applied, skipped };
}

const elementChildren = (n: HtmlNode): HtmlNode[] =>
  (n.childNodes ?? []).filter((c) => !!c.tagName);

function findBody(doc: HtmlNode): HtmlNode | null {
  if (doc.tagName === 'body') return doc;
  for (const c of elementChildren(doc)) {
    const b = findBody(c);
    if (b) return b;
  }
  return null;
}

/** Serializes the element at the picker child-index path (element children of <body>) as outer HTML. */
export function extractElementOuterHtml(html: string, indices: readonly number[]): string {
  const doc = parse(html, { sourceCodeLocationInfo: false }) as unknown as HtmlNode;
  let node = findBody(doc);
  if (!node) throw new Error('No <body> found in the document.');
  for (const i of indices) {
    const kids = elementChildren(node);
    if (i < 0 || i >= kids.length)
      throw new Error('The picked element path no longer matches the document.');
    node = kids[i];
  }
  return serialize({ childNodes: [node] } as never);
}

/** Minimal matcher for the selector shapes the picker emits: #id, [data-testid="x"], body > :nth-child(n) > ... */
function findBySelector(doc: HtmlNode, selector: string): HtmlNode | null {
  const all: HtmlNode[] = [];
  const visit = (n: HtmlNode): void => {
    all.push(n);
    for (const c of elementChildren(n)) visit(c);
  };
  visit(doc);
  if (selector.startsWith('body > :nth-child')) {
    const parts = selector.split('>').map((p) => p.trim());
    let current: HtmlNode | undefined = all.find((n) => n.tagName === 'body');
    for (const part of parts.slice(1)) {
      const m = part.match(/^:nth-child\((\d+)\)$/);
      if (!m || !current) return null;
      current = elementChildren(current)[Number(m[1]) - 1];
    }
    return current ?? null;
  }
  const simple = (n: HtmlNode): boolean => {
    if (selector.startsWith('#'))
      return !!n.attrs?.some((a) => a.name === 'id' && a.value === selector.slice(1));
    const m = selector.match(/^\[data-testid="(.*)"\]$/);
    if (m) return !!n.attrs?.some((a) => a.name === 'data-testid' && a.value === m[1]);
    return n.tagName === selector;
  };
  const found = all.filter((n) => n.tagName && simple(n));
  return found.length === 1 ? found[0] : null;
}

function findParent(doc: HtmlNode, target: HtmlNode): HtmlNode | null {
  for (const c of doc.childNodes ?? []) {
    if (c === target) return doc;
    const found = findParent(c, target);
    if (found) return found;
  }
  return null;
}

/**
 * Renders a document with every locked element replaced by its pinned HTML.
 * Elements whose selector no longer resolves are reported as failed; the rest
 * of the document renders unchanged.
 */
export interface AncestorContext {
  /** Attributes of the source document's <body>, to mirror on the card body. */
  bodyAttrs: { name: string; value: string }[];
  /** Serialized ancestor wrappers around the element, outermost first. */
  open: string[];
  close: string[];
}

/**
 * Ancestor chain (below <body>) around the element matching a selector, so an
 * isolated render keeps contextual styles like `.hero h1 { color: ... }`.
 */
export function extractAncestorContext(html: string, selector: string): AncestorContext {
  const doc = parse(html, { sourceCodeLocationInfo: false }) as unknown as HtmlNode;
  const empty: AncestorContext = { bodyAttrs: [], open: [], close: [] };
  const target = findBySelector(doc, selector);
  if (!target) return empty;
  const body = findBySelector(doc, 'body');
  const bodyAttrs = (body?.attrs ?? []).map((a) => ({ name: a.name, value: a.value }));
  const chain: HtmlNode[] = [];
  let node = findParent(doc, target);
  while (node && node !== body && node.tagName) {
    chain.unshift(node);
    node = findParent(doc, node);
  }
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return {
    bodyAttrs,
    open: chain.map(
      (n) => `<${n.tagName}${(n.attrs ?? []).map((a) => ` ${a.name}="${esc(a.value)}"`).join('')}>`
    ),
    close: chain.map((n) => `</${n.tagName}>`).reverse()
  };
}

/** Serialize the current element matching a lock selector, or null when absent. */
export function extractElementBySelector(html: string, selector: string): string | null {
  const doc = parse(html, { sourceCodeLocationInfo: false }) as unknown as HtmlNode;
  const target = findBySelector(doc, selector);
  return target ? serialize({ childNodes: [target] } as never) : null;
}

export function composeLockedDocument(
  html: string,
  locks: readonly { selector: string; pinnedHtml?: string }[],
  options?: { highlight?: boolean }
): { html: string; applied: string[]; failed: string[] } {
  const doc = parse(html, { sourceCodeLocationInfo: false }) as unknown as HtmlNode;
  const applied: string[] = [];
  const failed: string[] = [];
  for (const lock of locks) {
    if (!lock.pinnedHtml) {
      failed.push(lock.selector);
      continue;
    }
    const target = findBySelector(doc, lock.selector);
    const parent = target ? findParent(doc, target) : null;
    if (!target || !parent) {
      failed.push(lock.selector);
      continue;
    }
    const frag = parseFragment(lock.pinnedHtml, {
      sourceCodeLocationInfo: false
    }) as unknown as HtmlNode;
    const idx = (parent.childNodes ?? []).indexOf(target);
    if (idx < 0) {
      failed.push(lock.selector);
      continue;
    }
    const inserted = frag.childNodes ?? [];
    if (options?.highlight)
      for (const n of inserted)
        if (n.tagName) n.attrs = [...(n.attrs ?? []), { name: 'data-scrubline-lock', value: '' }];
    parent.childNodes!.splice(idx, 1, ...inserted);
    applied.push(lock.selector);
  }
  if (options?.highlight && applied.length) {
    const head = findBySelector(doc, 'head');
    if (head) {
      const styleNode = parseFragment(
        `<style>[data-scrubline-lock]{outline:3px solid #e5a00d !important;outline-offset:2px !important;box-shadow:0 0 0 6px rgba(229,160,13,0.25) !important}</style>`,
        { sourceCodeLocationInfo: false }
      ) as unknown as HtmlNode;
      head.childNodes = [...(head.childNodes ?? []), ...(styleNode.childNodes ?? [])];
    }
  }
  return {
    html: serialize(doc as never),
    applied,
    failed
  };
}
/** Stylesheet hrefs linked by a document, for rendering an element in isolation. */
export function extractStylesheetHrefs(html: string): string[] {
  const doc = parse(html, { sourceCodeLocationInfo: false }) as unknown as HtmlNode;
  const hrefs: string[] = [];
  const visit = (n: HtmlNode): void => {
    if (
      n.tagName === 'link' &&
      n.attrs?.some((a) => a.name === 'rel' && a.value === 'stylesheet')
    ) {
      const href = n.attrs?.find((a) => a.name === 'href')?.value;
      if (href) hrefs.push(href);
    }
    for (const c of n.childNodes ?? []) visit(c);
  };
  visit(doc);
  return hrefs;
}
