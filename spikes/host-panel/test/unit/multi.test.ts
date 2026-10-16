import { test, expect } from 'vitest';
import { composeCheckpoints } from '../../src/branches/multi';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HistoryStore } from '../../src/store/store';
import { scan, defaultLimits } from '../../src/capture/scanner';
import { Restore } from '../../src/review/restore';
import { hashBytes } from '../../src/store/store';
import type { Checkpoint, TrackedFile } from '../../src/bridge/timeline';

let counter = 0;
function mkCp(
  id: string,
  parentId: string | null,
  files: Record<string, string>,
  branch?: { id: string; name: string }
): Checkpoint {
  const tracked: TrackedFile[] = Object.entries(files)
    .map(([path, content]) => ({
      path,
      hash: hashBytes(content),
      size: content.length,
      mode: 0o644
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: 1,
    id,
    parentId,
    branch,
    createdAt: new Date(2026, 0, ++counter).toISOString(),
    trigger: 'save',
    files: tracked,
    attribution: { kind: 'unattributed' }
  };
}

const text = (cp: Checkpoint, path: string, all: Checkpoint[]) =>
  all.find((c) => c.id === cp.id)?.files.find((f) => f.path === path)?.hash;

// mainline chain: c1 (baseline) -> c2 (navbar) -> c3 (hero) -> c4 (footer+css)
const c1 = mkCp('c1', null, { 'index.html': 'v1', 'site.css': 'v1' });
const c2 = mkCp('c2', 'c1', { 'index.html': 'navbar', 'site.css': 'v1' });
const c3 = mkCp('c3', 'c2', { 'index.html': 'navbar+hero', 'site.css': 'v1' });
const c4 = mkCp('c4', 'c3', { 'index.html': 'navbar+hero', 'site.css': 'footer', 'extra.js': 'x' });
const chain = [c1, c2, c3, c4];
// A workspace checkpoint whose index.html is back at baseline content, so
// old deltas apply cleanly; site.css and extra.js carry divergent work.
const wc = mkCp('wc', 'c4', { 'index.html': 'v1', 'site.css': 'work-css', 'extra.js': 'x' });
const all = [...chain, wc];

test('one file in one checkpoint composes to exactly that change', async () => {
  const r = await composeCheckpoints(all, wc, ['c2'], 'combine');
  expect(r.conflicts).toEqual([]);
  expect(text(r.target, 'index.html', [r.target])).toBe(text(c2, 'index.html', all));
  // Untouched files keep current content, not c2's - delta semantics.
  expect(text(r.target, 'site.css', [r.target])).toBe(text(wc, 'site.css', all));
  expect(r.decisions.find((d) => d.path === 'index.html')?.sources).toEqual(['c2']);
});

test('N=1 combine applies the delta only: untouched files keep current content', async () => {
  // User decision: changes only, not entire workspace. Restore to c2 would
  // set site.css to c2's 'v1'; combine keeps the current 'work-css'.
  const r = await composeCheckpoints(all, wc, ['c2'], 'combine');
  expect(text(r.target, 'site.css', [r.target])).toBe(text(wc, 'site.css', all));
  expect(text(r.target, 'site.css', [r.target])).not.toBe(text(c2, 'site.css', all));
  expect(text(r.target, 'extra.js', [r.target])).toBe(text(wc, 'extra.js', all));
});

test('old delta against a moved mainline is an honest conflict, not a guess', async () => {
  // current c4: c3 changed index.html after c2, so c2's delta diverges.
  const r = await composeCheckpoints(chain, c4, ['c2'], 'combine');
  expect(r.conflicts).toEqual(['index.html']);
});

test('one file in several checkpoints folds in order, later wins on clean chain', async () => {
  // c2 and c3 both touched index.html, c3 builds on c2.
  const r = await composeCheckpoints(all, wc, ['c2', 'c3'], 'combine');
  expect(r.conflicts).toEqual([]);
  expect(text(r.target, 'index.html', [r.target])).toBe(text(c3, 'index.html', all));
});

test('divergent same-file edits conflict, unordered order decides nothing', async () => {
  // alternative branch from c2 with a different index.html
  const alt = mkCp(
    'b1',
    'c2',
    { 'index.html': 'alt-navbar', 'site.css': 'v1' },
    { id: 'br', name: 'alt' }
  );
  const withAlt = [...all, alt];
  const r = await composeCheckpoints(withAlt, wc, ['c3', 'b1'], 'combine');
  expect(r.conflicts).toEqual(['index.html']);
  expect(r.decisions.find((d) => d.path === 'index.html')?.status).toBe('conflict');
});

test('delete vs edit conflicts; delete on clean chain applies', async () => {
  const del = mkCp('c5', 'c4', { 'index.html': 'navbar+hero', 'site.css': 'footer' }); // deletes extra.js
  const edit = mkCp('c6', 'c4', {
    'index.html': 'navbar+hero',
    'site.css': 'footer',
    'extra.js': 'y'
  });
  const all = [...chain, del, edit];
  const conflict = await composeCheckpoints(all, edit, ['c5', 'c6'], 'combine');
  expect(conflict.conflicts).toEqual(['extra.js']);
  const clean = await await composeCheckpoints([...chain, del], del, ['c5'], 'combine');
  expect(clean.conflicts).toEqual([]);
  expect(text(clean.target, 'extra.js', [clean.target])).toBeUndefined();
});

test('revert removes exactly the checkpoint change; dependent edit conflicts with hint', async () => {
  // revert c2 (navbar) when nothing later depends: current is c2
  const clean = await composeCheckpoints(chain, c2, ['c2'], 'revert');
  expect(clean.conflicts).toEqual([]);
  expect(text(clean.target, 'index.html', [clean.target])).toBe(text(c1, 'index.html', chain));
  // revert c2 from c4: c3 built index.html on top of c2 -> conflict naming c3
  const blocked = await composeCheckpoints(chain, c4, ['c2'], 'revert');
  expect(blocked.conflicts).toEqual(['index.html']);
  expect(blocked.decisions[0].reason).toContain('c3');
  // selecting c3 too lets both unwind (reverse order: c3 first, then c2)
  const both = await composeCheckpoints(chain, c4, ['c2', 'c3'], 'revert');
  expect(both.conflicts).toEqual([]);
  expect(text(both.target, 'index.html', [both.target])).toBe(text(c1, 'index.html', chain));
});

test('baseline in combine warns; files differing from current conflict like any add over edit', async () => {
  const r = await composeCheckpoints(chain, c4, ['c1'], 'combine');
  expect(r.warnings.some((w) => w.includes('baseline'))).toBe(true);
  // current index.html and site.css both differ from baseline: add-over-edit conflicts
  expect(r.conflicts).toEqual(['index.html', 'site.css']);
  // where current already matches baseline content the add is a no-op
  const matching = mkCp('wm', null, { 'index.html': 'v1', 'site.css': 'v1' });
  const clean = await await composeCheckpoints([c1, matching], matching, ['c1'], 'combine');
  expect(clean.conflicts).toEqual([]);
  expect(clean.warnings.some((w) => w.includes('baseline'))).toBe(true);
});

test('mosaic picks per-file winners and keeps current elsewhere', async () => {
  const r = await composeCheckpoints(chain, c4, ['c2', 'c3'], 'mosaic', { 'index.html': 'c2' });
  expect(r.conflicts).toEqual([]);
  expect(text(r.target, 'index.html', [r.target])).toBe(text(c2, 'index.html', chain));
  expect(text(r.target, 'site.css', [r.target])).toBe(text(c4, 'site.css', chain));
  const keep = await composeCheckpoints(chain, c4, ['c2'], 'mosaic', { 'index.html': 'current' });
  expect(text(keep.target, 'index.html', [keep.target])).toBe(text(c4, 'index.html', chain));
});

test('dependency hint names the unselected later checkpoint touching the file', async () => {
  const r = await composeCheckpoints(chain, c4, ['c2'], 'combine');
  expect(r.hints).toContainEqual({ missing: 'c3', neededBy: 'c2', path: 'index.html' });
});

test('duplicates, unknown ids, cap and unsafe overrides are rejected', async () => {
  await expect(composeCheckpoints(chain, c4, ['c2', 'c2'], 'combine')).rejects.toThrow('Duplicate');
  await expect(composeCheckpoints(chain, c4, ['nope'], 'combine')).rejects.toThrow('Unknown');
  await expect(composeCheckpoints(chain, c4, ['c2', 'c3'], 'combine', {}, 1)).rejects.toThrow(
    'at most'
  );
  await expect(composeCheckpoints(chain, c4, [], 'combine')).rejects.toThrow('at least one');
  await expect(
    composeCheckpoints(chain, c4, ['c2'], 'mosaic', { 'index.html': 'c3' })
  ).rejects.toThrow('selected');
  await expect(
    composeCheckpoints(chain, c4, ['c2', 'c3'], 'mosaic', { '../x': 'c3' })
  ).rejects.toThrow('Unsafe');
});

test('composed target is one reconcile checkpoint parented on current', async () => {
  const r = await composeCheckpoints(chain, c4, ['c2', 'c4'], 'combine');
  expect(r.target.parentId).toBe(c4.id);
  expect(r.target.trigger).toBe('reconcile');
  expect(chain.some((c) => c.id === r.target.id)).toBe(false);
});

test('integration: composed candidate applies to disk and Undo restores the entire workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-multi-int-'));
  const work = path.join(root, 'project');
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, 'style.scss'), '.hero { color: blue; }\n');
  await fs.writeFile(path.join(work, 'App.tsx'), '<h1>Hello lab</h1>\n');
  const store = new HistoryStore(path.join(root, 'history'));
  await store.open();
  const capture = async () => {
    const s = await scan(work, store.root);
    return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
  };
  try {
    const base = await capture();
    // A: scss change only.
    await fs.writeFile(path.join(work, 'style.scss'), '.hero { color: red; }\n');
    const checkpointA = await capture();
    // B: tsx change only, on top of A (scss stays red so B's diff touches tsx alone).
    await fs.writeFile(path.join(work, 'App.tsx'), '<h1>Hi multi</h1>\n');
    const checkpointB = await capture();
    // Current: both edits reverted plus an unrelated user file.
    await fs.writeFile(path.join(work, 'style.scss'), '.hero { color: blue; }\n');
    await fs.writeFile(path.join(work, 'App.tsx'), '<h1>Hello lab</h1>\n');
    await fs.writeFile(path.join(work, 'notes.md'), 'keep me\n');
    const current = await capture();

    const composed = await composeCheckpoints(
      [base, checkpointA, checkpointB, current],
      current,
      [checkpointB.id, checkpointA.id],
      'combine'
    );
    expect(composed.conflicts).toEqual([]);
    expect(composed.target.parentId).toBe(current.id);

    const restore = new Restore(work, store, defaultLimits);
    const reviewed = await restore.review(composed.target, current, false);
    expect(reviewed.paths).toContain('style.scss');
    expect(reviewed.paths).toContain('App.tsx');
    const accepted = await restore.apply(
      reviewed.token,
      composed.target,
      false,
      undefined,
      undefined,
      {
        kind: 'composed',
        mode: 'combine',
        sources: [checkpointB.id, checkpointA.id]
      }
    );
    // Both checkpoint changes present; the unrelated later file survives.
    expect(await fs.readFile(path.join(work, 'style.scss'), 'utf8')).toContain('color: red');
    expect(await fs.readFile(path.join(work, 'App.tsx'), 'utf8')).toContain('Hi multi');
    expect(await fs.readFile(path.join(work, 'notes.md'), 'utf8')).toBe('keep me\n');
    expect(accepted.attribution.kind).toBe('composed');

    // Undo restores the entire pre-apply workspace.
    await restore.undo(store.checkpoints.at(-1)!, false);
    expect(await fs.readFile(path.join(work, 'style.scss'), 'utf8')).not.toContain('color: red');
    expect(await fs.readFile(path.join(work, 'App.tsx'), 'utf8')).not.toContain('Hi multi');
    expect(await fs.readFile(path.join(work, 'notes.md'), 'utf8')).toBe('keep me\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('integration: concurrent edit between multi review and confirm refuses with nothing applied', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-multi-conc-'));
  const work = path.join(root, 'project');
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, 'style.scss'), '.hero { color: blue; }\n');
  const store = new HistoryStore(path.join(root, 'history'));
  await store.open();
  const capture = async () => {
    const s = await scan(work, store.root);
    return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
  };
  try {
    const base = await capture();
    await fs.writeFile(path.join(work, 'style.scss'), '.hero { color: red; }\n');
    const checkpointA = await capture();
    await fs.writeFile(path.join(work, 'style.scss'), '.hero { color: blue; }\n');
    const current = await capture();

    const composed = await composeCheckpoints(
      [base, checkpointA, current],
      current,
      [checkpointA.id],
      'combine'
    );
    const restore = new Restore(work, store, defaultLimits);
    const reviewed = await restore.review(composed.target, current, false);
    // User edits the workspace after reviewing but before confirming.
    await fs.writeFile(path.join(work, 'concurrent.txt'), 'typed during review\n');
    await expect(restore.apply(reviewed.token, composed.target, false)).rejects.toThrow(
      'Concurrent edit. Nothing restored.'
    );
    // Nothing applied: scss untouched, the concurrent edit preserved.
    expect(await fs.readFile(path.join(work, 'style.scss'), 'utf8')).toContain('color: blue');
    expect(await fs.readFile(path.join(work, 'concurrent.txt'), 'utf8')).toBe(
      'typed during review\n'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('integration: workspace drift before multi review is reported as conflicts and blocks apply', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-multi-drift-'));
  const work = path.join(root, 'project');
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, 'style.scss'), '.hero { color: blue; }\n');
  const store = new HistoryStore(path.join(root, 'history'));
  await store.open();
  const capture = async () => {
    const s = await scan(work, store.root);
    return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
  };
  try {
    const base = await capture();
    await fs.writeFile(path.join(work, 'style.scss'), '.hero { color: red; }\n');
    const checkpointA = await capture();
    await fs.writeFile(path.join(work, 'style.scss'), '.hero { color: blue; }\n');
    const current = await capture();
    // Drift: the workspace no longer matches the observed current checkpoint.
    await fs.writeFile(path.join(work, 'style.scss'), '.hero { color: green; }\n');

    const composed = await composeCheckpoints(
      [base, checkpointA, current],
      current,
      [checkpointA.id],
      'combine'
    );
    const restore = new Restore(work, store, defaultLimits);
    const reviewed = await restore.review(composed.target, current, false);
    expect(reviewed.conflicts).toContain('style.scss');
    await expect(restore.apply(reviewed.token, composed.target, false)).rejects.toThrow(
      'Workspace drift'
    );
    expect(await fs.readFile(path.join(work, 'style.scss'), 'utf8')).toContain('color: green');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('composition identity binds set, order, mode and overrides', async () => {
  const base = mkCp('a'.repeat(64), null, { 'index.html': 'base' });
  const cp1 = mkCp('b'.repeat(64), base.id, { 'index.html': 'one' });
  const cp2 = mkCp('c'.repeat(64), base.id, { 'index.html': 'two' });
  const current = mkCp('d'.repeat(64), cp2.id, { 'index.html': 'now' });
  const all = [base, cp1, cp2, current];
  const mk = (
    ids: string[],
    mode: 'combine' | 'revert' | 'mosaic',
    overrides: Parameters<typeof composeCheckpoints>[4] = {}
  ) => composeCheckpoints(all, current, ids, mode, overrides);
  const identity = await mk([cp1.id, cp2.id], 'combine');
  // Same inputs recompose to the same identity.
  expect((await mk([cp1.id, cp2.id], 'combine')).compositionId).toBe(identity.compositionId);
  // Changed order invalidates.
  expect((await mk([cp2.id, cp1.id], 'combine')).compositionId).not.toBe(identity.compositionId);
  // Changed set invalidates.
  expect((await mk([cp1.id], 'combine')).compositionId).not.toBe(identity.compositionId);
  // Changed mode invalidates.
  expect((await mk([cp1.id, cp2.id], 'revert')).compositionId).not.toBe(identity.compositionId);
  // Changed overrides invalidate.
  expect((await mk([cp1.id, cp2.id], 'mosaic', { 'index.html': cp1.id })).compositionId).not.toBe(
    (await mk([cp1.id, cp2.id], 'mosaic', { 'index.html': cp2.id })).compositionId
  );
});

test('mosaic element pick splices the unique-id subtree and paired CSS only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-multi-el-'));
  const work = path.join(root, 'project');
  await fs.mkdir(work, { recursive: true });
  const html = (label: string) =>
    `<html><head><link rel="stylesheet" href="style.css"></head><body>` +
    `<header id="nav">${label}</header><main id="content">Body</main></body></html>`;
  const css = (color: string) => `#nav { color: ${color}; }\n#content { margin: 0; }\n`;
  await fs.writeFile(path.join(work, 'index.html'), html('Old nav'));
  await fs.writeFile(path.join(work, 'style.css'), css('blue'));
  const store = new HistoryStore(path.join(root, 'history'));
  await store.open();
  const capture = async () => {
    const s = await scan(work, store.root);
    return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
  };
  try {
    const base = await capture();
    await fs.writeFile(path.join(work, 'index.html'), html('New nav'));
    await fs.writeFile(path.join(work, 'style.css'), css('red'));
    const checkpointA = await capture();
    await fs.writeFile(path.join(work, 'index.html'), html('Old nav'));
    await fs.writeFile(path.join(work, 'style.css'), css('blue'));
    const current = await capture();

    const composed = await composeCheckpoints(
      [base, checkpointA, current],
      current,
      [checkpointA.id],
      'mosaic',
      { 'index.html': { source: checkpointA.id, element: 'nav' } },
      50,
      store
    );
    expect(composed.conflicts).toEqual([]);
    const read = async (cp: { files: { path: string; hash: string }[] }, p: string) =>
      (await store.readBlob(cp.files.find((f) => f.path === p)!.hash)).toString('utf8');
    const outHtml = await read(composed.target, 'index.html');
    expect(outHtml).toContain('New nav');
    expect(outHtml).toContain('Body');
    const outCss = await read(composed.target, 'style.css');
    expect(outCss).toContain('color: red');
    expect(outCss).toContain('#content');
    const navDecision = composed.decisions.find((d) => d.path === 'index.html')!;
    expect(navDecision.status).toBe('clean');
    expect(navDecision.reason).toContain('element #nav');
    const cssDecision = composed.decisions.find((d) => d.path === 'style.css')!;
    expect(cssDecision.status).toBe('clean');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('mosaic element refusal conflicts only that file; unrelated winners stay clean', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-multi-elref-'));
  const work = path.join(root, 'project');
  await fs.mkdir(work, { recursive: true });
  await fs.writeFile(path.join(work, 'index.html'), '<div id="box">Old</div>');
  await fs.writeFile(path.join(work, 'other.css'), 'body { margin: 0; }');
  const store = new HistoryStore(path.join(root, 'history'));
  await store.open();
  const capture = async () => {
    const s = await scan(work, store.root);
    return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
  };
  try {
    const base = await capture();
    await fs.writeFile(path.join(work, 'index.html'), '<div id="box">New</div>');
    await fs.writeFile(path.join(work, 'other.css'), 'body { margin: 8px; }');
    const checkpointA = await capture();
    await fs.writeFile(path.join(work, 'index.html'), '<div id="box">Old</div>');
    await fs.writeFile(path.join(work, 'other.css'), 'body { margin: 0; }');
    const current = await capture();

    const composed = await composeCheckpoints(
      [base, checkpointA, current],
      current,
      [checkpointA.id],
      'mosaic',
      {
        'index.html': { source: checkpointA.id, element: 'missing-id' },
        'other.css': checkpointA.id
      },
      50,
      store
    );
    // The missing element refuses on its file only.
    expect(composed.conflicts).toEqual(['index.html']);
    const refused = composed.decisions.find((d) => d.path === 'index.html')!;
    expect(refused.status).toBe('conflict');
    // The unrelated whole-file winner still applies cleanly.
    const other = composed.decisions.find((d) => d.path === 'other.css')!;
    expect(other.status).toBe('clean');
    const outCss = (
      await store.readBlob(composed.target.files.find((f) => f.path === 'other.css')!.hash)
    ).toString('utf8');
    expect(outCss).toContain('8px');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
