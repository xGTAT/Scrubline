import { test, expect } from 'vitest';
import { replaceActivation } from '../../src/lifecycle';
import { HistoryStore } from '../../src/store/store';
import { Timeline } from '../../src/capture/timeline';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
test('hot bundle replacement awaits old capture queue and releases writer without allowing a second live owner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-upgrade-'));
  const work = path.join(root, 'work');
  await fs.mkdir(work);
  await fs.writeFile(path.join(work, 'index.html'), 'old');
  const first = new Timeline(work, new HistoryStore(path.join(root, 'history')), () => {});
  await first.start();
  let stopped = false;
  const unregister = await replaceActivation(async () => {
    await first.dispose();
    stopped = true;
  });
  const second = new Timeline(work, new HistoryStore(first.store.root), () => {});
  const next = await replaceActivation(() => second.dispose());
  expect(stopped).toBe(true);
  await second.start();
  expect(second.state.status).toBe('ready');
  unregister();
  const competing = new HistoryStore(first.store.root);
  await expect(competing.acquireWriter()).rejects.toThrow('another window');
  await second.dispose();
  next();
  await fs.rm(root, { recursive: true, force: true });
});
test('same IDE session hands over endpoint ownership but a different window stays blocked', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-owner-'));
  let closed = false;
  const first = new HistoryStore(root, undefined, {
    identity: 'window-A',
    close: async () => {
      closed = true;
      await first.releaseWriter();
    }
  });
  await first.acquireWriter();
  const next = new HistoryStore(root, undefined, {
    identity: 'window-A',
    close: async () => next.releaseWriter()
  });
  await next.acquireWriter();
  expect(closed).toBe(true);
  const other = new HistoryStore(root, undefined, { identity: 'window-B', close: async () => {} });
  await expect(other.acquireWriter()).rejects.toThrow('another window');
  await next.releaseWriter();
  await fs.rm(root, { recursive: true, force: true });
});

test('upgrade waits for a real in-flight capture queue longer than the old three-second lease timeout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-slow-upgrade-'));
  const work = path.join(root, 'work');
  await fs.mkdir(work);
  await fs.writeFile(path.join(work, 'index.html'), 'old');
  let closes = 0;
  const first = new Timeline(
    work,
    new HistoryStore(path.join(root, 'history'), undefined, {
      identity: 'same-window',
      close: async () => {
        closes++;
        await first.dispose();
      }
    }),
    () => {}
  );
  await first.start();
  const busy = first.exclusive(() => new Promise<void>((resolve) => setTimeout(resolve, 4200)));
  const next = new HistoryStore(first.store.root, undefined, {
    identity: 'same-window',
    close: async () => {}
  });
  try {
    await next.acquireWriter();
    await busy;
    expect(closes).toBeGreaterThan(0);
    await next.open();
    expect(next.checkpoints).toHaveLength(1);
  } finally {
    await first.dispose();
    await next.releaseWriter();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 12000);
