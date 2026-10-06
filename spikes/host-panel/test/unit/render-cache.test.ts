import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RenderCache, renderKey, prepareHistory, PNG } from '../../src/preview/cache';
import { HistoryStore } from '../../src/store/store';
import { scopedStore } from '../../src/store/identity';
test('cache prepares once, repeat selections require no render, config invalidates and failures/cancel are explicit', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-cache-'));
  try {
    const store = new HistoryStore(path.join(temp, 'store'));
    await store.open();
    const a = await store.commit([], new Map(), 'baseline', { kind: 'unattributed' });
    const b = await store.commit([], new Map(), 'save', { kind: 'unattributed' });
    const image = path.join(temp, 'image.png');
    await fs.writeFile(image, Buffer.concat([PNG, Buffer.from('test-only')]));
    const cache = new RenderCache(
      store.root,
      renderKey({ command: 'node server', port: 4100, timeoutMs: 15000 })
    );
    let calls = 0;
    const render = async () => {
      calls++;
      return image;
    };
    const progress = await prepareHistory(
      [a, b],
      cache,
      render,
      () => false,
      () => {}
    );
    expect(progress.done).toBe(2);
    expect(calls).toBe(2);
    await prepareHistory(
      [a, b],
      cache,
      render,
      () => false,
      () => {}
    );
    expect(calls).toBe(2);
    expect(await cache.get(a.id)).toBeDefined();
    const different = new RenderCache(
      store.root,
      renderKey({ command: 'node other', port: 4100, timeoutMs: 15000 })
    );
    expect(await different.get(a.id)).toBeUndefined();
    const failed = await prepareHistory(
      [a],
      different,
      async () => {
        throw new Error('build missing');
      },
      () => false,
      () => {}
    );
    expect(failed.failed).toBe(1);
    expect(failed.message).toBe('build missing');
    let cancel = false;
    const stopped = await prepareHistory(
      [a, b],
      different,
      async () => {
        cancel = true;
        return image;
      },
      () => cancel,
      () => {}
    );
    expect(stopped.cancelled).toBe(true);
    expect(stopped.done).toBe(0);
    expect(await different.get(a.id)).toBeUndefined();
    await expect(new RenderCache(store.root, 'limit', 1).put(a.id, image)).rejects.toThrow('limit');
    const totalSize = (await fs.stat(image)).size * 2;
    await expect(
      new RenderCache(store.root, 'different-generation', totalSize).put(a.id, image)
    ).rejects.toThrow('limit');
    await cache.clear();
    expect(await cache.get(a.id)).toBeUndefined();
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
test('folder identity isolates saved-workspace roots and preserves unverified legacy store', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-scope-'));
  try {
    const a = path.join(temp, 'a'),
      b = path.join(temp, 'b'),
      base = path.join(temp, 'storage');
    await fs.mkdir(a);
    await fs.mkdir(b);
    await fs.mkdir(base);
    await fs.writeFile(path.join(base, 'legacy'), 'preserve');
    const first = await scopedStore(base, a);
    const second = await scopedStore(base, b);
    expect(first).not.toBe(second);
    expect(await scopedStore(base, a)).toBe(first);
    expect(await fs.readFile(path.join(base, 'legacy'), 'utf8')).toBe('preserve');
    await fs.writeFile(path.join(first, 'workspace.json'), '{}');
    await expect(scopedStore(base, a)).rejects.toThrow('mismatch');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
