import { test, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { chromium } from 'playwright-core';
import { HistoryStore } from '../../src/store/store';
import { scan, defaultLimits } from '../../src/capture/scanner';
import { Restore } from '../../src/review/restore';
import { PreviewRunner } from '../../src/preview/runner';
const roots: string[] = [];
const runners: PreviewRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.stop();
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});
async function setup() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-m2-'));
  roots.push(temp);
  const root = path.join(temp, 'project');
  await fs.mkdir(root);
  const store = new HistoryStore(path.join(temp, 'store'));
  await store.open();
  return { temp, root, store };
}
async function capture(root: string, store: HistoryStore) {
  const s = await scan(root, store.root);
  return store.commit(s.files, s.contents, 'watcher', { kind: 'unattributed' });
}
async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}
// Durable restore journals and Undo perform many synced file writes. Hosted
// Windows runners can exceed Vitest's 5s default without a functional failure.
test(
  'review then apply and undo restore exact bytes; exclusions untouched',
  async () => {
    const { root, store } = await setup();
    await fs.writeFile(path.join(root, 'a'), 'earlier');
    await fs.writeFile(path.join(root, '.env'), 'secret');
    const a = await capture(root, store);
    await fs.rename(path.join(root, 'a'), path.join(root, 'b'));
    await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 255, 13, 10]));
    const b = await capture(root, store);
    const restore = new Restore(root, store, defaultLimits);
    const review = await restore.review(a, b, false);
    expect(review.paths).toEqual(['a', 'b', 'binary']);
    const applied = await restore.apply(review.token, a, false);
    expect((await scan(root, store.root)).files).toEqual(a.files);
    expect(await fs.readFile(path.join(root, '.env'), 'utf8')).toBe('secret');
    await restore.undo(applied, false);
    expect((await scan(root, store.root)).files).toEqual(b.files);
    expect(await fs.readFile(path.join(root, '.env'), 'utf8')).toBe('secret');
  },
  process.platform === 'win32' ? 15000 : 5000
);
test('drift, unsaved buffers and concurrent edits stop before write', async () => {
  const { root, store } = await setup();
  await fs.writeFile(path.join(root, 'a'), 'earlier');
  const a = await capture(root, store);
  await fs.writeFile(path.join(root, 'a'), 'later');
  const b = await capture(root, store);
  const restore = new Restore(root, store, defaultLimits);
  await expect(restore.review(a, b, true)).rejects.toThrow('unsaved');
  await fs.writeFile(path.join(root, 'a'), 'drift');
  const drift = await restore.review(a, b, false);
  expect(drift.conflicts).toEqual(['a']);
  await expect(restore.apply(drift.token, a, false)).rejects.toThrow('drift');
  expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('drift');
  const current = await capture(root, store);
  const review = await restore.review(a, current, false);
  await expect(
    restore.apply(review.token, a, false, async () => {
      await fs.writeFile(path.join(root, 'a'), 'concurrent');
    })
  ).rejects.toThrow('Concurrent');
  expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('concurrent');
  await restore.recover();
});
test('symlink destinations blocked; expired review cannot mutate', async () => {
  const { root, store } = await setup();
  await fs.writeFile(path.join(root, 'a'), 'earlier');
  const a = await capture(root, store);
  await fs.writeFile(path.join(root, 'a'), 'later');
  const b = await capture(root, store);
  const restore = new Restore(root, store, defaultLimits);
  await expect(restore.apply('bad', a, false)).rejects.toThrow('expired');
  if (process.platform !== 'win32') {
    const review = await restore.review(a, b, false);
    await fs.unlink(path.join(root, 'a'));
    await fs.symlink(path.join(root, '.env'), path.join(root, 'a'));
    await fs.writeFile(path.join(root, '.env'), 'secret');
    await expect(restore.apply(review.token, a, false)).rejects.toThrow();
    expect(await fs.readFile(path.join(root, '.env'), 'utf8')).toBe('secret');
  }
});
test('startup exited, busy port, timeout and trust failures are actionable', async () => {
  const { store, root } = await setup();
  const port = await freePort();
  const runner = new PreviewRunner(
    { command: 'node -e "process.exit(1)"', port, timeoutMs: 1000 },
    store
  );
  runners.push(runner);
  await expect(runner.start(root, false)).rejects.toThrow('Trust');
  await expect(runner.start(root, true)).rejects.toThrow('exited');
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  await expect(runner.start(root, true)).rejects.toThrow('busy');
  await new Promise<void>((r) => server.close(() => r()));
  const timeout = new PreviewRunner(
    { command: 'node -e "setInterval(()=>{},1000)"', port, timeoutMs: 200 },
    store
  );
  runners.push(timeout);
  await expect(timeout.start(root, true)).rejects.toThrow('timed out');
});
test('isolated historical states render differently and never mutate workspace; thumbnails bound to ids', async () => {
  const { store, root } = await setup();
  await fs.cp(path.resolve('../../fixtures/sample-web'), root, { recursive: true });
  const a = await capture(root, store);
  const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  await fs.writeFile(
    path.join(root, 'index.html'),
    html.replace('State B (Agent Modified)', 'Historical second state')
  );
  const b = await capture(root, store);
  const before = (await scan(root, store.root)).files;
  const runner = new PreviewRunner(
    {
      command: 'node server.js --port {port}',
      port: await freePort(),
      timeoutMs: 5000,
      browserPath: chromium.executablePath()
    },
    store
  );
  runners.push(runner);
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const first = await runner.historical(a, true);
    await page.goto(first.url!);
    expect(await page.locator('body').innerText()).toContain('State B (Agent Modified)');
    expect(first.screenshot, first.error).toBeDefined();
    expect(first.screenshot).toContain(a.id);
    const regions = JSON.parse(await fs.readFile(`${first.screenshot}.json`, 'utf8'));
    expect(regions.find((r: { key: string }) => r.key === 'app-title')).toBeDefined();
    expect(JSON.stringify(regions)).not.toContain('Scrubline Sample Application');
    await fs.mkdir(path.resolve('../../docs/evidence'), { recursive: true });
    await fs.copyFile(
      first.screenshot!,
      path.resolve('../../docs/evidence/m2_actual_historical_a.png')
    );
    const second = await runner.historical(b, true);
    await page.goto(second.url!);
    expect(await page.locator('body').innerText()).toContain('Historical second state');
    expect(second.screenshot, second.error).toBeDefined();
    expect(second.screenshot).toContain(b.id);
    await fs.copyFile(
      second.screenshot!,
      path.resolve('../../docs/evidence/m2_actual_historical_b.png')
    );
    expect((await scan(root, store.root)).files).toEqual(before);
  } finally {
    await browser.close();
  }
  const broken = new PreviewRunner(
    { command: 'node missing.js', port: await freePort(), timeoutMs: 1000 },
    store
  );
  runners.push(broken);
  expect((await broken.historical(a, true)).label).toBe('Screenshot');
}, 20000);
test('Undo refuses intervening edits, even if watcher already captured them', async () => {
  const { root, store } = await setup();
  await fs.writeFile(path.join(root, 'a'), 'earlier');
  const a = await capture(root, store);
  await fs.writeFile(path.join(root, 'a'), 'later');
  const b = await capture(root, store);
  const restore = new Restore(root, store, defaultLimits);
  const review = await restore.review(a, b, false);
  await restore.apply(review.token, a, false);
  await fs.writeFile(path.join(root, 'a'), 'user edit after restore');
  const watched = await capture(root, store);
  await expect(restore.undo(watched, false)).rejects.toThrow('drift');
  expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('user edit after restore');
});
test('partial transaction fails then rolls back completed files without losing edit', async () => {
  const { root, store } = await setup();
  await fs.writeFile(path.join(root, 'a'), 'older a');
  await fs.writeFile(path.join(root, 'z'), 'older z');
  const a = await capture(root, store);
  await fs.writeFile(path.join(root, 'a'), 'newer a');
  await fs.writeFile(path.join(root, 'z'), 'newer z');
  const b = await capture(root, store);
  const restore = new Restore(root, store, defaultLimits);
  const review = await restore.review(a, b, false);
  // A destination directory cannot be silently replaced with a file.
  await expect(
    restore.apply(review.token, a, false, async () => {
      await fs.unlink(path.join(root, 'z'));
      await fs.mkdir(path.join(root, 'z'));
    })
  ).rejects.toThrow();
  expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('newer a');
  expect((await fs.stat(path.join(root, 'z'))).isDirectory()).toBe(true);
});

test('preview startup errors keep exit status and send bounded stderr to diagnostics', async () => {
  const { root, store } = await setup();
  await fs.writeFile(
    path.join(root, 'fail.cjs'),
    "console.error('fixture launch reason');process.exit(7)"
  );
  const runner = new PreviewRunner(
    { command: 'node fail.cjs', port: await freePort(), timeoutMs: 1000 },
    store
  );
  runners.push(runner);
  await expect(runner.start(root, true)).rejects.toThrow(
    /Preview process exited \(7\).*Check command/
  );
});
// Preview diagnostics regression boundary.

test('deep bound history keeps child working directory short and cleans it', async () => {
  const { temp, root } = await setup();
  const store = new HistoryStore(path.join(temp, 'deep'.repeat(30), 'bound'.repeat(20)));
  await store.open();
  await fs.writeFile(
    path.join(root, 'server.cjs'),
    "require('http').createServer((q,r)=>r.end('ok')).listen(process.env.PORT,'127.0.0.1')"
  );
  const cp = await capture(root, store);
  const diagnostics: string[] = [];
  const runner = new PreviewRunner(
    { command: 'node server.cjs', port: await freePort(), timeoutMs: 3000 },
    store,
    undefined,
    (message) => diagnostics.push(message)
  );
  runners.push(runner);
  const result = await runner.historical(cp, true);
  expect(result.url).toBeDefined();
  expect(diagnostics).toContain(
    `[checkpoint ${cp.id}] Screenshot failed: Set a Chromium path for screenshots.`
  );
  const directory = (runner as unknown as { temp: string }).temp;
  expect(directory.length).toBeLessThan(store.root.length);
  await runner.stop();
  await expect(fs.access(directory)).rejects.toThrow();
});
// Deep-path preview regression boundary.

test('failed command keeps stderr in diagnostics, not timeline error', async () => {
  const { root, store } = await setup();
  const diagnostics: string[] = [];
  const runner = new PreviewRunner(
    { command: 'node missing-test.js', port: await freePort(), timeoutMs: 2000 },
    store,
    undefined,
    (message) => diagnostics.push(message)
  );
  runners.push(runner);
  await expect(runner.start(root, true)).rejects.toThrow('Check command and Scrubline output.');
  expect(runner.status()).not.toContain('MODULE_NOT_FOUND');
  expect(diagnostics.join('\n')).toContain('MODULE_NOT_FOUND');
});
