import { test, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { scan, changedPaths, defaultLimits } from '../../src/capture/scanner';
import { HistoryStore, hashBytes, migrate, safePath } from '../../src/store/store';
import { Timeline } from '../../src/capture/timeline';
const roots: string[] = [];
const active: Timeline[] = [];
afterEach(async () => {
  for (const t of active.splice(0)) await t.dispose();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-'));
  roots.push(temp);
  const root = path.join(temp, 'project');
  await fs.mkdir(root);
  const store = new HistoryStore(path.join(temp, 'history'));
  await store.open();
  return { temp, root, store };
}
async function commit(root: string, store: HistoryStore) {
  const s = await scan(root, store.root);
  return store.commit(s.files, s.contents, 'watcher', { kind: 'unattributed' });
}
test('capture, rename, delete, atomic replacement and binary bytes survive restart', async () => {
  const { root, store, temp } = await setup();
  await fs.writeFile(path.join(root, 'a.txt'), 'first\r\n');
  const a = await commit(root, store);
  await fs.rename(path.join(root, 'a.txt'), path.join(root, 'b.txt'));
  await fs.writeFile(path.join(root, 'swap.tmp'), Buffer.from([0, 255, 1, 13, 10]));
  await fs.rename(path.join(root, 'swap.tmp'), path.join(root, 'b.txt'));
  const b = await commit(root, store);
  await fs.unlink(path.join(root, 'b.txt'));
  const c = await commit(root, store);
  const reopened = new HistoryStore(store.root);
  expect((await reopened.open()).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
  for (const cp of reopened.checkpoints) {
    const dest = path.join(temp, cp.id);
    await reopened.materialize(cp, dest);
    const restored = await scan(dest, store.root);
    expect(restored.files.map((f) => [f.path, f.hash, f.size])).toEqual(
      cp.files.map((f) => [f.path, f.hash, f.size])
    );
  }
  expect(changedPaths(a.files, b.files)).toEqual(['a.txt', 'b.txt']);
  expect(c.files).toEqual([]);
});
test('ignore built-ins, nested rules and negation; secrets are excluded', async () => {
  const { root, store } = await setup();
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, '.gitignore'), '*.log\n!keep.log\n');
  await fs.writeFile(path.join(root, 'src', '.gitignore'), 'hidden.txt\n');
  for (const name of [
    'a.log',
    'keep.log',
    '.env.local',
    'src/hidden.txt',
    'src/yes.txt',
    'node_modules/x'
  ])
    await fs.writeFile(path.join(root, name), 'value');
  const s = await scan(root, store.root);
  expect(s.files.map((f) => f.path)).toEqual([
    '.gitignore',
    'keep.log',
    'src/.gitignore',
    'src/yes.txt'
  ]);
});
test('limits reject whole capture, leaving history unchanged', async () => {
  const { root, store } = await setup();
  await fs.writeFile(path.join(root, 'large'), '1234');
  await expect(scan(root, store.root, { ...defaultLimits, maxFileBytes: 3 })).rejects.toThrow(
    'limit'
  );
  await expect(scan(root, store.root, { ...defaultLimits, maxFiles: 0 })).rejects.toThrow('limit');
  expect(store.checkpoints).toEqual([]);
});
test('external symlinks and case collisions fail visibly', async () => {
  const { root, store, temp } = await setup();
  await fs.writeFile(path.join(temp, 'outside'), 'private');
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(temp, 'outside'), path.join(root, 'link'));
    await expect(scan(root, store.root)).rejects.toThrow('External symlink');
    await fs.unlink(path.join(root, 'link'));
    await fs.writeFile(path.join(root, 'A'), 'a');
    await fs.writeFile(path.join(root, 'a'), 'b');
    await expect(scan(root, store.root)).rejects.toThrow('Case-colliding');
  }
  expect(safePath('C:/project/a')).toBe(false);
  expect(safePath('..\\secret')).toBe(false);
  expect(safePath('../secret')).toBe(false);
});
test('long paths and CRLF capture exact bytes', async () => {
  const { root, store } = await setup();
  const relative = Array(8).fill('long-segment-abcdefghij').join('/') + '/file.txt';
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), 'a\r\nb\r\n');
  const c = await commit(root, store);
  expect(c.files[0].hash).toBe(hashBytes('a\r\nb\r\n'));
  expect(c.files[0].path).toBe(relative);
});
test('missed watcher events recovered, no duplicate checkpoint, failures displayed', async () => {
  const { root, store } = await setup();
  const t = new Timeline(root, store, () => {});
  active.push(t);
  await t.start(40);
  expect(t.state.status).toBe('ready');
  await fs.writeFile(path.join(root, 'new'), 'value');
  await new Promise((r) => setTimeout(r, 150));
  await t.capture('reconcile');
  expect(t.state.rows).toHaveLength(2);
  await t.capture('reconcile');
  expect(t.state.rows).toHaveLength(2);
  t.dirty(true);
  expect(t.state.unsaved).toBe(true);
});
test('edit bursts debounce to one stable checkpoint', async () => {
  const { root, store } = await setup();
  const t = new Timeline(root, store, () => {});
  active.push(t);
  await t.start();
  for (let i = 0; i < 8; i++) {
    await fs.writeFile(path.join(root, `${i}.txt`), String(i));
    t.event('watcher');
  }
  await new Promise((r) => setTimeout(r, 450));
  await t.capture('reconcile');
  expect(store.checkpoints).toHaveLength(2);
  expect(store.checkpoints[1].files).toHaveLength(8);
});
test('schema and blob corruption stop recovery, never half checkpoints', async () => {
  const { root, store } = await setup();
  await fs.writeFile(path.join(root, 'a'), 'a');
  const c = await commit(root, store);
  expect(() => migrate({ ...c, schemaVersion: 2 })).toThrow('version');
  await fs.writeFile(path.join(store.root, 'manifests', 'interrupted.tmp'), 'partial');
  expect(await new HistoryStore(store.root).open()).toHaveLength(1);
  await fs.writeFile(path.join(store.root, 'blobs', c.files[0].hash), 'broken');
  await expect(new HistoryStore(store.root).open()).rejects.toThrow('checksum');
});
test('quota failure is visible and does not accept a checkpoint', async () => {
  const { root, store } = await setup();
  const limited = new HistoryStore(store.root, 1);
  await limited.open();
  const t = new Timeline(root, limited, () => {});
  active.push(t);
  await t.start();
  expect(t.state.status).toBe('limit');
  expect(limited.checkpoints).toHaveLength(0);
});
test('hook attribution requires workspace AND exact content, not time overlap', async () => {
  const { root, store, temp } = await setup();
  const log = path.join(temp, 'hook-events.jsonl');
  const t = new Timeline(root, store, () => {}, defaultLimits, log);
  active.push(t);
  await t.start();
  await fs.writeFile(path.join(root, 'a'), 'new');
  await fs.writeFile(
    log,
    JSON.stringify({
      event: 'post-tool',
      timestamp: new Date().toISOString(),
      workspace: hashBytes(await fs.realpath(root)),
      targetFile: 'a',
      contentHash: hashBytes('wrong'),
      tool: 'edit'
    }) + '\n'
  );
  await t.capture('watcher');
  expect(store.checkpoints.at(-1)?.attribution.kind).toBe('unattributed');
  await fs.writeFile(path.join(root, 'a'), 'exact');
  await fs.appendFile(
    log,
    JSON.stringify({
      event: 'post-tool',
      workspace: hashBytes(await fs.realpath(root)),
      targetFile: 'a',
      contentHash: hashBytes('exact'),
      tool: 'edit'
    }) + '\n'
  );
  await t.capture('watcher');
  expect(store.checkpoints.at(-1)?.attribution).toEqual({
    kind: 'hook',
    paths: ['a'],
    tool: 'edit'
  });
});
test('property: every accepted checkpoint reproduces randomly generated bytes', async () => {
  const { root, store, temp } = await setup();
  let seed = 12345;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  for (let n = 0; n < 20; n++) {
    const bytes = Buffer.from(Array.from({ length: next() % 512 }, () => next() % 256));
    await fs.writeFile(path.join(root, `${next() % 4}.bin`), bytes);
    await commit(root, store);
  }
  const reopened = new HistoryStore(store.root);
  await reopened.open();
  for (let i = 0; i < reopened.checkpoints.length; i++) {
    const c = reopened.checkpoints[i];
    const dest = path.join(temp, `restored-${i}`);
    await reopened.materialize(c, dest);
    const s = await scan(dest, store.root);
    expect(s.files.map((f) => [f.path, f.hash])).toEqual(c.files.map((f) => [f.path, f.hash]));
  }
});
test('excluded symlink targets never capture secret bytes', async () => {
  if (process.platform === 'win32') return;
  const { root, store } = await setup();
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=secret');
  await fs.symlink(path.join(root, '.env'), path.join(root, 'exposed.txt'));
  await expect(scan(root, store.root)).rejects.toThrow('Excluded symlink target');
});
test('single writer lease prevents multiple windows from forking history', async () => {
  const { store } = await setup();
  await store.acquireWriter();
  const other = new HistoryStore(store.root);
  await expect(other.acquireWriter()).rejects.toThrow('another window');
  await store.releaseWriter();
  await other.acquireWriter();
  await other.releaseWriter();
});

test('writer recovers abandoned same-PID endpoint and waits for restart release', async () => {
  const { store } = await setup();
  await fs.writeFile(
    path.join(store.root, 'writer.lock'),
    JSON.stringify({ pid: process.pid, token: 'abandoned-instance', port: 1 })
  );
  await store.acquireWriter();
  const next = new HistoryStore(store.root);
  const timer = setTimeout(() => void store.releaseWriter(), 120);
  try {
    await next.acquireWriter();
    await next.releaseWriter();
  } finally {
    clearTimeout(timer);
    await store.releaseWriter();
  }
});
