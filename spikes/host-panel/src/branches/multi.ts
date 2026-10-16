import { hashBytes, safePath, type HistoryStore } from '../store/store';
import { changedPaths } from '../capture/scanner';
import { elementCandidate } from './element';
import type { Checkpoint, TrackedFile } from '../bridge/timeline';

export type MultiMode = 'combine' | 'revert' | 'mosaic';

export interface FileDecision {
  path: string;
  /** Selected checkpoint ids touching this file, in apply order. */
  sources: string[];
  status: 'clean' | 'conflict' | 'unchanged';
  reason?: string;
}

export interface DependencyHint {
  /** Unselected checkpoint that also touches the file. */
  missing: string;
  /** Selected checkpoint whose change sits on top of it. */
  neededBy: string;
  path: string;
}

export interface ComposeResult {
  target: Checkpoint;
  decisions: FileDecision[];
  /** Paths whose conflict blocks apply. */
  conflicts: string[];
  warnings: string[];
  hints: DependencyHint[];
  /**
   * Identity of the exact composition: mode, ordered ids, overrides and the
   * resulting file set. Changes when the set, order, mode or overrides
   * change; the review receipt binds this, and apply refuses when a stale
   * review no longer matches the current selection.
   */
  compositionId: string;
}

/** Per-file winner in mosaic mode: a selected checkpoint id, 'current', or
 * an element-level pick (unique id subtree plus paired id-scoped CSS, static
 * HTML only, existing refusal rules) from a selected checkpoint. */
export type MosaicWinner = string | { source: string; element: string };
export type MosaicOverrides = Record<string, MosaicWinner>;

const winnerSource = (w: MosaicWinner | undefined) => (typeof w === 'string' ? w : w?.source);

const same = (a?: TrackedFile, b?: TrackedFile) => a?.hash === b?.hash && a?.mode === b?.mode;

function byId(checkpoints: readonly Checkpoint[]) {
  return new Map(checkpoints.map((c) => [c.id, c]));
}

function fileOf(c: Checkpoint | undefined, path: string) {
  return c?.files.find((f) => f.path === path);
}

function shortId(id: string) {
  return id.slice(0, 8);
}

/**
 * Compose N selected checkpoints into ONE synthetic target checkpoint that
 * plugs into Restore.review/apply unchanged. Checkpoints stay immutable;
 * the result of applying is a single new reconcile checkpoint.
 *
 * combine: for each selected checkpoint, three-way whole-file merge its
 *   parent-diff into the running result, in apply order. "Later wins" only
 *   where the chain is clean; true divergence is a whole-file conflict.
 * revert: inverse of each diff, applied latest-first; the inverse applies
 *   only while the file still matches the checkpoint's own result,
 *   otherwise a dependent later change exists and is reported as a
 *   conflict naming the dependent checkpoint.
 * mosaic: per-file winner via overrides; files without an override keep
 *   current content. No merging, so no conflicts from composition itself.
 */
export async function composeCheckpoints(
  checkpoints: readonly Checkpoint[],
  current: Checkpoint,
  ids: readonly string[],
  mode: MultiMode,
  overrides: MosaicOverrides = {},
  maxIds = 50,
  store?: HistoryStore
): Promise<ComposeResult> {
  if (!ids.length) throw new Error('Select at least one checkpoint.');
  if (ids.length > maxIds) throw new Error(`Select at most ${maxIds} checkpoints.`);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate checkpoints selected.');
  const index = byId(checkpoints);
  const selected = ids.map((id) => {
    const c = index.get(id);
    if (!c) throw new Error(`Unknown checkpoint ${shortId(id)}.`);
    return c;
  });
  for (const [p, winner] of Object.entries(overrides)) {
    if (!safePath(p)) throw new Error('Unsafe override path.');
    const src = winnerSource(winner);
    if (!src) throw new Error('Mosaic winner required.');
    if (src !== 'current' && !index.has(src))
      throw new Error(`Unknown override checkpoint ${shortId(src)}.`);
    if (src !== 'current' && !ids.includes(src))
      throw new Error('Mosaic winner must be one of the selected checkpoints.');
    if (typeof winner === 'object') {
      if (!/^[A-Za-z][\w-]*$/.test(winner.element))
        throw new Error('Element picks need a simple unique element id.');
      if (!p.endsWith('.html')) throw new Error('Element picks apply to static HTML files only.');
      if (!store) throw new Error('Element picks need the history store.');
    }
  }

  const children = new Map<string, Checkpoint[]>();
  for (const c of checkpoints) {
    if (!c.parentId) continue;
    const list = children.get(c.parentId) ?? [];
    list.push(c);
    children.set(c.parentId, list);
  }
  /** Earliest descendant of `of` that changed `path` relative to its own parent. */
  const dependentsOf = (of: Checkpoint, path: string): Checkpoint | undefined => {
    const queue = [...(children.get(of.id) ?? [])];
    const visited = new Set<string>();
    while (queue.length) {
      const d = queue.shift()!;
      if (visited.has(d.id)) continue;
      visited.add(d.id);
      const parent = parentOf(d);
      if (parent && changedPaths(parent.files, d.files).includes(path)) return d;
      queue.push(...(children.get(d.id) ?? []));
    }
    return undefined;
  };

  const warnings: string[] = [];
  const decisions = new Map<string, FileDecision>();
  const decision = (path: string) => {
    let d = decisions.get(path);
    if (!d) {
      d = { path, sources: [], status: 'unchanged' };
      decisions.set(path, d);
    }
    return d;
  };

  const running = new Map(current.files.map((f) => [f.path, f]));
  const parentOf = (c: Checkpoint) => (c.parentId ? index.get(c.parentId) : undefined);

  if (mode === 'mosaic') {
    const touched = new Set<string>();
    for (const c of selected)
      for (const p of changedPaths(parentOf(c)?.files ?? [], c.files)) touched.add(p);
    for (const p of [...touched].sort()) {
      const d = decision(p);
      d.sources = selected
        .filter((c) => changedPaths(parentOf(c)?.files ?? [], c.files).includes(p))
        .map((c) => c.id);
      const winner = overrides[p];
      if (!winner || winner === 'current' || typeof winner === 'object') continue;
      const w = fileOf(index.get(winner), p);
      if (same(running.get(p), w)) continue;
      if (w) running.set(p, w);
      else running.delete(p);
      d.status = 'clean';
    }
    // Element-level picks: splice the unique-id subtree (plus paired
    // id-scoped CSS) from the chosen checkpoint into the current file. Uses
    // the existing static-HTML element machinery, so its refusal rules
    // (shared CSS, scripts, embedded styles, ambiguous ownership) apply; a
    // refusal conflicts only that file, never unrelated files.
    for (const p of [...touched].sort()) {
      const winner = overrides[p];
      if (!winner || typeof winner !== 'object') continue;
      const d = decision(p);
      d.reason = `element #${winner.element}`;
      try {
        const candidate = await elementCandidate(
          store!,
          index.get(winner.source)!,
          current,
          p,
          winner.element
        );
        const changed = changedPaths(current.files, candidate.files);
        const collision = changed.find(
          (q) => q !== p && overrides[q] && winnerSource(overrides[q]) !== 'current'
        );
        if (collision)
          throw new Error(
            `Element pick touches ${collision}, which has its own winner. Resolve one side.`
          );
        for (const q of changed) {
          const f = fileOf(candidate, q);
          if (f) running.set(q, f);
          else running.delete(q);
          if (q !== p) {
            const extra = decision(q);
            extra.sources = [winner.source];
            extra.status = 'clean';
            extra.reason = `paired CSS for element #${winner.element} in ${p}`;
          }
        }
        d.status = changed.length ? 'clean' : 'unchanged';
      } catch (e) {
        d.status = 'conflict';
        d.reason = `element #${winner.element}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  } else if (mode === 'combine') {
    for (const c of selected) {
      const parent = parentOf(c);
      if (!parent)
        warnings.push(
          `Checkpoint ${shortId(c.id)} is the baseline: no parent diff, so every one of its files is treated as added. Prefer plain restore for it.`
        );
      for (const p of changedPaths(parent?.files ?? [], c.files)) {
        const d = decision(p);
        if (!d.sources.includes(c.id)) d.sources.push(c.id);
        const b = fileOf(parent, p);
        const s = fileOf(c, p);
        const r = running.get(p);
        if (same(b, s) || same(r, s)) {
          if (d.status === 'unchanged') d.status = 'clean';
          continue;
        }
        if (!same(b, r)) {
          d.status = 'conflict';
          d.reason = `${p}: changed on both sides of checkpoint ${shortId(c.id)}.`;
          continue;
        }
        if (s) running.set(p, s);
        else running.delete(p);
        if (d.status === 'unchanged') d.status = 'clean';
      }
    }
  } else {
    // revert: unwind in reverse apply order so dependents detach first.
    for (const c of [...selected].reverse()) {
      const parent = parentOf(c);
      if (!parent) {
        warnings.push(
          `Checkpoint ${shortId(c.id)} is the baseline: nothing to revert it against. Skipped.`
        );
        continue;
      }
      for (const p of changedPaths(parent.files, c.files)) {
        const d = decision(p);
        if (!d.sources.includes(c.id)) d.sources.push(c.id);
        const b = fileOf(parent, p);
        const s = fileOf(c, p);
        const r = running.get(p);
        if (same(r, b)) {
          if (d.status === 'unchanged') d.status = 'clean';
          continue;
        }
        if (!same(r, s)) {
          const dependent = dependentsOf(c, p);
          d.status = 'conflict';
          d.reason = dependent
            ? `${p}: checkpoint ${shortId(dependent.id)} also edits this file after ${shortId(c.id)}. Add it to the selection.`
            : `${p}: file no longer matches checkpoint ${shortId(c.id)}'s result; a later change depends on it.`;
          continue;
        }
        if (b) running.set(p, b);
        else running.delete(p);
        if (d.status === 'unchanged') d.status = 'clean';
      }
    }
  }

  // Dependency hints: an unselected ancestor-side checkpoint between the
  // selection and the current head that touches the same file. Hint only.
  const hints: DependencyHint[] = [];
  if (mode !== 'mosaic') {
    const selectedSet = new Set(ids);
    const seenHints = new Set<string>();
    for (const c of selected) {
      const stack = [...(children.get(c.id) ?? [])];
      const visited = new Set<string>();
      while (stack.length) {
        const d = stack.pop()!;
        if (visited.has(d.id)) continue;
        visited.add(d.id);
        if (!selectedSet.has(d.id)) {
          for (const p of changedPaths(parentOf(c)?.files ?? [], c.files)) {
            const dp = parentOf(d);
            if (dp && changedPaths(dp.files, d.files).includes(p)) {
              const key = `${d.id}:${c.id}:${p}`;
              if (!seenHints.has(key)) {
                seenHints.add(key);
                hints.push({ missing: d.id, neededBy: c.id, path: p });
              }
            }
          }
        }
        stack.push(...(children.get(d.id) ?? []));
      }
    }
  }

  const conflicts = [...decisions.values()]
    .filter((d) => d.status === 'conflict')
    .map((d) => d.path);
  const body: Omit<Checkpoint, 'id'> = {
    schemaVersion: 1,
    parentId: current.id,
    createdAt: new Date().toISOString(),
    trigger: 'reconcile',
    files: [...running.values()].sort((a, b) => a.path.localeCompare(b.path)),
    attribution: { kind: 'unattributed' }
  };
  const files = body.files;
  const canonicalOverrides = Object.keys(overrides)
    .sort()
    .map((k) => [k, overrides[k]]);
  const compositionId = hashBytes(
    JSON.stringify({
      mode,
      ids,
      overrides: canonicalOverrides,
      files: files.map((f) => [f.path, f.hash, f.mode])
    })
  );
  return {
    target: { id: hashBytes(JSON.stringify(body)), ...body },
    decisions: [...decisions.values()].sort((a, b) => a.path.localeCompare(b.path)),
    conflicts,
    warnings,
    hints,
    compositionId
  };
}
