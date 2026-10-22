import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RenderCache, PNG } from '../../src/preview/cache';
import { HistoryStore, hashBytes } from '../../src/store/store';

test('used-bytes counter matches a full rescan after commits, putBlob and compact', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-used-'));
  try {
    const store = new HistoryStore(path.join(temp, 'store'));
    await store.open();
    await store.commit([], new Map(), 'baseline', { kind: 'unattributed' });
    const bytes = Buffer.from('hello blob');
    const hash = hashBytes(bytes);
    await store.putBlob(hash, bytes);
    await store.putBlob(hash, bytes);
    const scan = async () => {
      let n = 0;
      for (const d of ['blobs', 'manifests'])
        for (const f of await fs.readdir(path.join(store.root, d)))
          n += (await fs.stat(path.join(store.root, d, f))).size;
      return n;
    };
    expect(await store.usedBytes()).toBe(await scan());
    await store.compact();
    expect(await store.usedBytes()).toBe(await scan());
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('quota still rejects a new blob that does not fit', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-quota-'));
  try {
    const store = new HistoryStore(path.join(temp, 'store'), 64);
    await store.open();
    const bytes = Buffer.alloc(200, 1);
    await expect(store.putBlob(hashBytes(bytes), bytes)).rejects.toThrow('Storage limit reached.');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((c) => c.repeat(64));
test('render cache evicts the oldest render at the cap instead of failing', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-lru-'));
  try {
    const cache = new RenderCache(temp, 'cfg', 3000);
    const make = async (name: string) => {
      const file = path.join(temp, `${name}.png`);
      await fs.writeFile(file, Buffer.concat([PNG, Buffer.alloc(1000, 7)]));
      return file;
    };
    for (const id of [A, B, C]) {
      await cache.put(id, await make(id));
      await new Promise((r) => setTimeout(r, 15));
    }
    await cache.put(D, await make('d'));
    expect(await cache.get(A)).toBeUndefined();
    expect(await cache.get(D)).toBeDefined();
    expect(await cache.get(C)).toBeDefined();
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
