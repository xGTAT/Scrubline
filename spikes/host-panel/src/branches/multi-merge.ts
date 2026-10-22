import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse, serialize, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5';
import { hashBytes, HistoryStore, safePath } from '../store/store';
import type { Checkpoint } from '../bridge/timeline';
import { staticSectionPaths, APPROVED_TAGS } from './static-mapping';

export interface ElementSelection {
  checkpoint: Checkpoint;
  base: Checkpoint;
  document: string;
  selector?: string;
  fingerprint?: string;
}

export interface ElementResolvedFiles {
  selection: ElementSelection;
  paths: string[];
  document: string;
}

export interface MultiMergeItem {
  base: Checkpoint;
  selected: Checkpoint;
  paths: string[];
  document?: string;
  selector?: string;
}

export interface MultiMergeResult {
  target: Checkpoint;
  conflicts: string[];
  elements: { selector?: string; paths: string[] }[];
  allPaths: string[];
}

export interface ASTNode {
  nodeName?: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: ASTNode[];
  parentNode?: ASTNode | null;
}

export function matchElement(node: ASTNode, selector?: string, fingerprint?: string): boolean {
  if (!node || !node.tagName) return false;

  let fp:
    | {
        tag?: string;
        id?: string;
        testid?: string | null;
        role?: string | null;
        href?: string | null;
      }
    | undefined;
  if (fingerprint) {
    try {
      fp = JSON.parse(fingerprint) as typeof fp;
    } catch {
      /* ignore invalid fingerprint JSON */
    }
  }

  if (fp) {
    if (fp.tag && node.tagName.toLowerCase() !== fp.tag.toLowerCase()) return false;
    if (fp.id) {
      const id = node.attrs?.find((a) => a.name === 'id')?.value;
      if (id !== fp.id) return false;
    }
    if (fp.testid) {
      const testid = node.attrs?.find((a) => a.name === 'data-testid')?.value;
      if (testid !== fp.testid) return false;
    }
  }

  if (!selector) return true;

  const s = selector.trim();
  // ID selector e.g. '#my-id'
  if (s.startsWith('#') && !s.includes(' ') && !s.includes('>')) {
    const id = s.slice(1);
    return !!node.attrs?.some((a) => a.name === 'id' && a.value === id);
  }
  // Class selector e.g. '.my-class'
  if (s.startsWith('.') && !s.includes(' ') && !s.includes('>')) {
    const cls = s.slice(1);
    const classAttr = node.attrs?.find((a) => a.name === 'class')?.value;
    return !!classAttr && classAttr.split(/\s+/).includes(cls);
  }
  // Tag with ID e.g. 'nav#my-id'
  if (s.includes('#') && !s.includes(' ') && !s.includes('>')) {
    const [tag, id] = s.split('#');
    return (
      node.tagName === tag.toLowerCase() &&
      !!node.attrs?.some((a) => a.name === 'id' && a.value === id)
    );
  }
  // Tag with class e.g. 'nav.my-class'
  if (s.includes('.') && !s.includes(' ') && !s.includes('>')) {
    const [tag, cls] = s.split('.');
    const classAttr = node.attrs?.find((a) => a.name === 'class')?.value;
    return (
      node.tagName === tag.toLowerCase() && !!classAttr && classAttr.split(/\s+/).includes(cls)
    );
  }
  // Single tag name e.g. 'nav', 'footer'
  if (/^[a-zA-Z][\w-]*$/.test(s)) {
    return node.tagName === s.toLowerCase();
  }
  // Descendant / child chain e.g. 'body > nav'
  const parts = s.split(/\s*>\s*/);
  const last = parts.at(-1)!;
  if (!matchElement(node, last)) return false;
  let curr = node.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (curr && !matchElement(curr, parts[i])) {
      curr = curr.parentNode;
    }
    if (!curr) return false;
    curr = curr.parentNode;
  }
  return true;
}

export function collectMatchingElements(
  tree: ASTNode,
  selector?: string,
  fingerprint?: string
): ASTNode[] {
  const matches: ASTNode[] = [];
  function walk(node: ASTNode) {
    if (matchElement(node, selector, fingerprint)) {
      matches.push(node);
    }
    for (const child of node.childNodes ?? []) {
      walk(child);
    }
  }
  walk(tree);
  return matches;
}

export function isDescendant(child: ASTNode, parent: ASTNode): boolean {
  let curr = child.parentNode;
  while (curr) {
    if (curr === parent) return true;
    curr = curr.parentNode;
  }
  return false;
}

export function validateSubtree(node: ASTNode): void {
  function check(n: ASTNode) {
    if (n.tagName) {
      if (!APPROVED_TAGS.has(n.tagName)) {
        throw new Error(`Ambiguous element ownership: unapproved tag <${n.tagName}>.`);
      }
      if (['script', 'iframe', 'style'].includes(n.tagName)) {
        throw new Error(`Ambiguous element ownership: tag <${n.tagName}> is not allowed.`);
      }
      if (n.attrs?.some((a) => a.name.startsWith('on') || a.name === 'style')) {
        throw new Error('Ambiguous element ownership: inline style or event handler blocked.');
      }
    }
    for (const c of n.childNodes ?? []) check(c);
  }
  check(node);
}

export function replaceNode(oldNode: ASTNode, newNode: ASTNode): void {
  const parent = oldNode.parentNode;
  if (!parent || !parent.childNodes) return;
  const idx = parent.childNodes.indexOf(oldNode);
  if (idx >= 0) {
    parent.childNodes[idx] = newNode;
    newNode.parentNode = parent;
  }
}

/**
 * Resolves each element's owned files per element.
 * If two elements target the same document on the same page, ensures they target
 * distinct, non-overlapping element subtrees.
 */
export async function resolveElementFiles(
  store: HistoryStore,
  selections: ElementSelection[]
): Promise<ElementResolvedFiles[]> {
  const resolved: (ElementResolvedFiles & { node?: ASTNode })[] = [];

  for (let i = 0; i < selections.length; i++) {
    const sel = selections[i];

    if (!sel.selector) {
      const paths = await staticSectionPaths(store, sel.checkpoint, sel.document);
      resolved.push({ selection: sel, paths, document: sel.document });
      continue;
    }

    let owningDoc = sel.document;
    let matchedNode: ASTNode | undefined = undefined;

    const docEntry = sel.checkpoint.files.find((f) => f.path === sel.document);
    if (docEntry) {
      const html = (await store.readBlob(docEntry.hash)).toString('utf8');
      const tree = parse(html) as unknown as ASTNode;
      const matches = collectMatchingElements(tree, sel.selector, sel.fingerprint);
      if (matches.length === 1) {
        matchedNode = matches[0];
        owningDoc = sel.document;
      }
    }

    if (!matchedNode) {
      for (const file of sel.checkpoint.files.filter(
        (f) => f.path.endsWith('.html') && f.path !== sel.document
      )) {
        const html = (await store.readBlob(file.hash)).toString('utf8');
        const tree = parse(html) as unknown as ASTNode;
        const matches = collectMatchingElements(tree, sel.selector, sel.fingerprint);
        if (matches.length === 1) {
          matchedNode = matches[0];
          owningDoc = file.path;
          break;
        }
      }
    }

    if (!matchedNode) {
      throw new Error(
        `Ambiguous element ownership. Selector "${sel.selector}" must match exactly one element.`
      );
    }

    validateSubtree(matchedNode);

    const owningEntry = sel.checkpoint.files.find((f) => f.path === owningDoc)!;
    const owningHtml = (await store.readBlob(owningEntry.hash)).toString('utf8');
    const tree = parse(owningHtml) as unknown as ASTNode;
    const links: ASTNode[] = [];
    function findLinks(n: ASTNode) {
      if (n.tagName === 'link') links.push(n);
      for (const c of n.childNodes ?? []) findLinks(c);
    }
    findLinks(tree);

    const paths = [owningDoc];
    const prefix = owningDoc.includes('/')
      ? owningDoc.slice(0, owningDoc.lastIndexOf('/') + 1)
      : '';
    for (const link of links) {
      const rel = link.attrs?.find((a) => a.name === 'rel')?.value;
      const href = link.attrs?.find((a) => a.name === 'href')?.value;
      if (rel === 'stylesheet' && href && safePath(href) && !href.includes('/')) {
        const cssPath = prefix + href;
        if (sel.checkpoint.files.some((f) => f.path === cssPath)) {
          paths.push(cssPath);
        }
      }
    }

    resolved.push({
      selection: { ...sel, document: owningDoc },
      paths,
      document: owningDoc,
      node: matchedNode
    });
  }

  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i];
      const b = resolved[j];

      if (a.document === b.document) {
        if (
          !a.selection.selector ||
          !b.selection.selector ||
          a.selection.selector === b.selection.selector
        ) {
          throw new Error(
            `Overlapping file ownership blocked: "${a.document}" elements must be non-overlapping.`
          );
        }
        const docEntry =
          a.selection.checkpoint.files.find((f) => f.path === a.document) ??
          b.selection.checkpoint.files.find((f) => f.path === b.document);
        if (docEntry) {
          const html = (await store.readBlob(docEntry.hash)).toString('utf8');
          const sharedTree = parse(html) as unknown as ASTNode;
          const matchesA = collectMatchingElements(
            sharedTree,
            a.selection.selector,
            a.selection.fingerprint
          );
          const matchesB = collectMatchingElements(
            sharedTree,
            b.selection.selector,
            b.selection.fingerprint
          );
          if (matchesA.length === 1 && matchesB.length === 1) {
            const nodeA = matchesA[0];
            const nodeB = matchesB[0];
            if (nodeA === nodeB || isDescendant(nodeA, nodeB) || isDescendant(nodeB, nodeA)) {
              throw new Error(
                `Overlapping file ownership blocked: "${a.document}" elements must be non-overlapping.`
              );
            }
          }
        }
      } else {
        for (const p of a.paths) {
          if (b.paths.includes(p)) {
            throw new Error(
              `Overlapping file ownership blocked: "${p}" is owned by multiple elements.`
            );
          }
        }
      }
    }
  }

  return resolved.map((r) => ({
    selection: r.selection,
    paths: r.paths,
    document: r.document
  }));
}

/**
 * Three-way whole-file and element-level merge across multiple element path sets.
 * If two elements target the same document, their element subtrees are merged into
 * the document without throwing overlapping file errors.
 */
export function mergeMultiElements(
  current: Checkpoint,
  items: MultiMergeItem[],
  store?: HistoryStore
): MultiMergeResult {
  const files = new Map(current.files.map((f) => [f.path, f]));
  const conflicts: string[] = [];
  const elements: { selector?: string; paths: string[] }[] = [];
  const allPaths: string[] = [];

  for (const item of items) {
    elements.push({ selector: item.selector, paths: [...item.paths] });
    for (const p of item.paths) {
      if (!allPaths.includes(p)) allPaths.push(p);
    }
  }

  const htmlDocs = new Set(
    items
      .filter((item) => item.selector && (item.document || item.paths[0])?.endsWith('.html'))
      .map((item) => item.document ?? item.paths[0])
  );

  const mergedHtmlDocs = new Set<string>();

  for (const docPath of htmlDocs) {
    const docItems = items.filter(
      (item) => item.selector && (item.document ?? item.paths[0]) === docPath
    );
    const c = files.get(docPath);
    if (!c) {
      conflicts.push(docPath);
      continue;
    }
    if (!store) {
      continue;
    }

    const currentBlobPath = path.join(store.root, 'blobs', c.hash);
    if (!fs.existsSync(currentBlobPath)) {
      conflicts.push(docPath);
      continue;
    }

    const currentHtml = fs.readFileSync(currentBlobPath, 'utf8');
    const currentTree = parse(currentHtml) as unknown as ASTNode;
    let docModified = false;

    for (const item of docItems) {
      const b = item.base.files.find((f) => f.path === docPath);
      const s = item.selected.files.find((f) => f.path === docPath);
      if (!b || !s) {
        conflicts.push(`${docPath} [${item.selector}]`);
        continue;
      }

      const baseBlobPath = path.join(store.root, 'blobs', b.hash);
      const selectedBlobPath = path.join(store.root, 'blobs', s.hash);
      if (!fs.existsSync(baseBlobPath) || !fs.existsSync(selectedBlobPath)) {
        conflicts.push(`${docPath} [${item.selector}]`);
        continue;
      }

      const baseHtml = fs.readFileSync(baseBlobPath, 'utf8');
      const selectedHtml = fs.readFileSync(selectedBlobPath, 'utf8');

      const baseTree = parse(baseHtml) as unknown as ASTNode;
      const selectedTree = parse(selectedHtml) as unknown as ASTNode;

      const baseNodes = collectMatchingElements(baseTree, item.selector);
      const selectedNodes = collectMatchingElements(selectedTree, item.selector);
      const currentNodes = collectMatchingElements(currentTree, item.selector);

      if (baseNodes.length !== 1 || selectedNodes.length !== 1 || currentNodes.length !== 1) {
        conflicts.push(`${docPath} [${item.selector}]`);
        continue;
      }

      const baseOuter = serializeOuter(baseNodes[0] as unknown as DefaultTreeAdapterTypes.Node);
      const selectedOuter = serializeOuter(
        selectedNodes[0] as unknown as DefaultTreeAdapterTypes.Node
      );
      const currentOuter = serializeOuter(
        currentNodes[0] as unknown as DefaultTreeAdapterTypes.Node
      );

      if (baseOuter === selectedOuter || currentOuter === selectedOuter) {
        continue;
      }
      if (baseOuter !== currentOuter) {
        conflicts.push(`${docPath} [${item.selector}]`);
        continue;
      }

      replaceNode(currentNodes[0], selectedNodes[0]);
      docModified = true;
    }

    if (docModified && !conflicts.some((c) => c.startsWith(docPath))) {
      const mergedHtml = serialize(currentTree as unknown as DefaultTreeAdapterTypes.ParentNode);
      const mergedBytes = Buffer.from(mergedHtml, 'utf8');
      const mergedHash = hashBytes(mergedBytes);
      const targetBlob = path.join(store.root, 'blobs', mergedHash);
      if (!fs.existsSync(targetBlob)) {
        fs.writeFileSync(targetBlob, mergedBytes);
        store.invalidateUsed();
      }
      files.set(docPath, {
        path: docPath,
        hash: mergedHash,
        size: mergedBytes.length,
        mode: c.mode
      });
    }
    mergedHtmlDocs.add(docPath);
  }

  for (const item of items) {
    for (const p of item.paths) {
      if (mergedHtmlDocs.has(p)) continue;

      const b = item.base.files.find((f) => f.path === p);
      const c = files.get(p);
      const s = item.selected.files.find((f) => f.path === p);
      const same = (x: typeof b, y: typeof b) => x?.hash === y?.hash && x?.mode === y?.mode;

      if (same(b, s) || same(c, s)) continue;
      if (!same(b, c)) {
        conflicts.push(p);
        continue;
      }
      if (s) files.set(p, s);
      else files.delete(p);
    }
  }

  const body: Omit<Checkpoint, 'id'> = {
    schemaVersion: 1,
    parentId: current.id,
    createdAt: new Date().toISOString(),
    trigger: 'reconcile',
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    attribution: { kind: 'unattributed' }
  };

  return {
    target: { id: hashBytes(JSON.stringify(body)), ...body },
    conflicts: [...new Set(conflicts)],
    elements,
    allPaths
  };
}
