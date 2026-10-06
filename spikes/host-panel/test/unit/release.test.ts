import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { HistoryStore, hashBytes } from '../../src/store/store';
import { scan, defaultLimits } from '../../src/capture/scanner';
test('compaction retains all referenced snapshots, collects orphan blobs, restart restores bytes', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-release-'));
  try {
    const root = path.join(temp, 'project');
    await fs.mkdir(root);
    const store = new HistoryStore(path.join(temp, 'history'));
    await store.open();
    await fs.writeFile(path.join(root, 'a'), 'keep');
    const snapshot = await scan(root, store.root);
    const cp = await store.commit(snapshot.files, snapshot.contents, 'baseline', {
      kind: 'unattributed'
    });
    const orphan = hashBytes('orphan');
    await fs.writeFile(path.join(store.root, 'blobs', orphan), 'orphan');
    expect(await store.compact()).toBe(6);
    expect(await store.readBlob(cp.files[0].hash)).toEqual(Buffer.from('keep'));
    const restart = new HistoryStore(store.root);
    await restart.open();
    await restart.materialize(cp, path.join(temp, 'restored'));
    expect(await fs.readFile(path.join(temp, 'restored', 'a'), 'utf8')).toBe('keep');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
test('1000 checkpoint restart keeps immutable ancestry within a measured budget', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-1000-'));
  try {
    const store = new HistoryStore(temp);
    await store.open();
    // Exercise actual manifest persistence, not a production fixture.
    // Whole-test budget includes 1000 durable writes and conservative per-commit quota scans.
    // Windows shared runners can spend >90s here; restart still has its own strict 15s assertion.
    for (let i = 0; i < 1000; i++)
      await store.commit([], new Map(), 'save', { kind: 'unattributed' });
    const start = performance.now();
    const before = process.memoryUsage().heapUsed;
    const cpu = process.cpuUsage();
    const restart = new HistoryStore(temp);
    await restart.open();
    const metrics = {
      elapsedMs: Math.round(performance.now() - start),
      heapDeltaMB: Math.round((process.memoryUsage().heapUsed - before) / 1024 / 1024),
      cpuMs: Math.round((process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000)
    };
    console.log('1000-checkpoint restart', JSON.stringify(metrics));
    expect(restart.checkpoints).toHaveLength(1000);
    expect(metrics.elapsedMs).toBeLessThan(15000);
  } finally {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 240000);

test('ignore additions exclude user paths without disabling built-in secret exclusions', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-ignore-'));
  try {
    const root = path.join(temp, 'project');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'keep'), 'ok');
    await fs.writeFile(path.join(root, 'private.txt'), 'private');
    await fs.writeFile(path.join(root, '.env'), 'secret');
    const result = await scan(root, path.join(temp, 'history'), {
      ...defaultLimits,
      ignoreAdditions: ['private.txt']
    });
    expect(result.files.map((f) => f.path)).toEqual(['keep']);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
