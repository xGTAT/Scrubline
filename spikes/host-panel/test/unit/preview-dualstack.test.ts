import { test, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { HistoryStore } from '../../src/store/store';
import { PreviewRunner } from '../../src/preview/runner';

const roots: string[] = [];
const runners: PreviewRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.stop();
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});
async function setup() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-ds-'));
  roots.push(temp);
  const root = path.join(temp, 'project');
  await fs.mkdir(root);
  const store = new HistoryStore(path.join(temp, 'store'));
  await store.open();
  return { temp, root, store };
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
async function ipv6Loopback() {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(0, '::1', () => server.close(() => resolve(true)));
  });
}
function runner(port: number, store: HistoryStore) {
  const r = new PreviewRunner({ command: 'node server.cjs', port, timeoutMs: 8000 }, store);
  runners.push(r);
  return r;
}

// Vite and several framework dev servers bind "localhost" to ::1 only on
// IPv6-first systems; the startup probe must find them there instead of
// waiting only on 127.0.0.1 until the timeout.
test('preview probe reaches a server bound to ::1 only', async (t) => {
  if (!(await ipv6Loopback())) t.skip();
  const { root, store } = await setup();
  await fs.writeFile(
    path.join(root, 'server.cjs'),
    `require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end('<h1>v6</h1>')}).listen(process.env.PORT,'::1')`
  );
  const port = await freePort();
  const url = await runner(port, store).start(root, true);
  expect(url).toBe(`http://[::1]:${port}`);
});

test('preview probe still prefers a server bound to 127.0.0.1', async () => {
  const { root, store } = await setup();
  await fs.writeFile(
    path.join(root, 'server.cjs'),
    `require('http').createServer((q,r)=>{r.setHeader('content-type','text/html');r.end('<h1>v4</h1>')}).listen(process.env.PORT,'127.0.0.1')`
  );
  const port = await freePort();
  const url = await runner(port, store).start(root, true);
  expect(url).toBe(`http://127.0.0.1:${port}`);
});
