import { hashBytes, HistoryStore } from '../store/store';
import type { Checkpoint } from '../bridge/timeline';
import { staticSectionPaths } from './static-mapping';

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
}

export interface MultiMergeItem {
  base: Checkpoint;
  selected: Checkpoint;
  paths: string[];
  selector?: string;
}

export interface MultiMergeResult {
  target: Checkpoint;
  conflicts: string[];
  elements: { selector?: string; paths: string[] }[];
  allPaths: string[];
}

/**
 * Resolves each element's owned files via staticSectionPaths and asserts that
 * no files overlap between distinct elements. If any element fails static ownership
 * or if two elements share a file (e.g. shared CSS), an error is thrown.
 */
export async function resolveElementFiles(
  store: HistoryStore,
  selections: ElementSelection[]
): Promise<ElementResolvedFiles[]> {
  const resolved: ElementResolvedFiles[] = [];
  const seenPaths = new Map<string, number>();

  for (let i = 0; i < selections.length; i++) {
    const sel = selections[i];
    const paths = await staticSectionPaths(store, sel.checkpoint, sel.document);
    for (const p of paths) {
      if (seenPaths.has(p)) {
        throw new Error(
          `Overlapping file ownership blocked: "${p}" is owned by multiple elements.`
        );
      }
      seenPaths.set(p, i);
    }
    resolved.push({ selection: sel, paths });
  }

  return resolved;
}

/**
 * Three-way whole-file merge across multiple element path sets from multiple checkpoints.
 * Any three-way conflict in any file is collected in `conflicts`.
 */
export function mergeMultiElements(
  current: Checkpoint,
  items: MultiMergeItem[]
): MultiMergeResult {
  const files = new Map(current.files.map((f) => [f.path, f]));
  const conflicts: string[] = [];
  const elements: { selector?: string; paths: string[] }[] = [];
  const allPaths: string[] = [];

  for (const item of items) {
    elements.push({ selector: item.selector, paths: [...item.paths] });
    for (const p of item.paths) {
      allPaths.push(p);
      const b = item.base.files.find((f) => f.path === p);
      const c = files.get(p);
      const s = item.selected.files.find((f) => f.path === p);
      const same = (x: typeof b, y: typeof b) =>
        x?.hash === y?.hash && x?.mode === y?.mode;

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
