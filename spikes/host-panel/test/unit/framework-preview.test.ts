import { test, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { HistoryStore } from '../../src/store/store';
import { scan } from '../../src/capture/scanner';
import { PreviewRunner } from '../../src/preview/runner';

const roots: string[] = [];
const runners: PreviewRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.stop();
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});
async function setup() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-fw-'));
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

// Snapshots never contain node_modules (the scanner excludes it), so a
// dev-server command can only run in a snapshot when the runner links the
// workspace's install in. The fake "framework" server refuses to start
// unless its dependency is reachable from the snapshot cwd.
const SERVER = `const fs=require('fs');
if(!fs.existsSync(require('path').join(process.cwd(),'node_modules','dep','index.js')))process.exit(1);
require('http').createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<h1>framework snapshot served</h1>')}).listen(process.env.PORT,'127.0.0.1')`;

test('snapshot with package.json links the workspace node_modules; without it the command fails', async () => {
  const { root, store } = await setup();
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fake-framework', scripts: { dev: 'node server.cjs' } })
  );
  await fs.writeFile(path.join(root, 'server.cjs'), SERVER);
  await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
  const checkpoint = await capture(root, store);
  // The scanner must keep dependencies out of the snapshot.
  expect(checkpoint.files.some((f) => f.path.startsWith('node_modules/'))).toBe(false);
  expect(checkpoint.files.some((f) => f.path === 'package.json')).toBe(true);

  const linked = new PreviewRunner(
    { command: 'node server.cjs', port: await freePort(), timeoutMs: 8000 },
    store,
    undefined,
    undefined,
    root
  );
  runners.push(linked);
  const result = await linked.historical(checkpoint, true);
  expect(result.url, result.error).toBeDefined();
  const body = await fetch(result.url!).then((r) => r.text());
  expect(body).toContain('framework snapshot served');
  // The live workspace install was never mutated by the preview.
  await fs.access(path.join(root, 'node_modules', 'dep', 'index.js'));

  const isolated = new PreviewRunner(
    { command: 'node server.cjs', port: await freePort(), timeoutMs: 8000 },
    store
  );
  runners.push(isolated);
  await expect(isolated.historical(checkpoint, true)).rejects.toThrow(/exited|unavailable/i);
}, 30000);

test('static snapshots without package.json are left alone', async () => {
  const { root, store } = await setup();
  await fs.writeFile(path.join(root, 'index.html'), '<h1>static</h1>');
  await fs.writeFile(
    path.join(root, 'server.cjs'),
    `require('http').createServer((req,res)=>{res.end('<h1>static</h1>')}).listen(process.env.PORT,'127.0.0.1')`
  );
  const checkpoint = await capture(root, store);
  const runner = new PreviewRunner(
    { command: 'node server.cjs', port: await freePort(), timeoutMs: 8000 },
    store,
    undefined,
    undefined,
    root
  );
  runners.push(runner);
  const result = await runner.historical(checkpoint, true);
  expect(result.url, result.error).toBeDefined();
}, 30000);
