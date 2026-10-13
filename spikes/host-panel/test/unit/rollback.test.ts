import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HistoryStore } from '../../src/store/store';
import { scan, defaultLimits } from '../../src/capture/scanner';
import { Restore } from '../../src/review/restore';
import { declarationChanges } from '../../src/investigation/change-units';
import { inverseCss } from '../../src/investigation/rollback';
test('inverse CSS keeps later unrelated values but refuses drift and overlapping properties', () => {
  const before = 'nav{min-width:0px;background:red}',
    after = 'nav{min-width:900px;background:blue}';
  const units = declarationChanges('site.css', before, after).filter(
    (u) => u.property === 'min-width'
  );
  expect(inverseCss('nav{min-width:900px;background:green}', units)).toBe(
    'nav{min-width:0px;background:green}'
  );
  expect(() => inverseCss('nav{min-width:901px;background:blue}', units)).toThrow('base');
  expect(() => inverseCss(after + 'p{min-width:20px}', units)).toThrow('ownership');
  expect(() => inverseCss(after, declarationChanges('site.css', before, after))).toThrow(
    'independent'
  );
});
test('failed post-write guard uses journal rollback and preserves a concurrent edit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-rollback-'));
  try {
    const workspace = path.join(root, 'project');
    await fs.mkdir(workspace);
    const store = new HistoryStore(path.join(root, 'history'));
    await store.open();
    const capture = async (text: string) => {
      await fs.writeFile(path.join(workspace, 'site.css'), text);
      const c = await scan(workspace, store.root);
      return store.commit(c.files, c.contents, 'save', { kind: 'unattributed' });
    };
    const good = await capture('nav{min-width:0px}'),
      bad = await capture('nav{min-width:900px}');
    const restore = new Restore(workspace, store, defaultLimits);
    let review = await restore.review(good, bad, false);
    await expect(
      restore.apply(review.token, good, false, undefined, async () => {
        throw new Error('Guard failed');
      })
    ).rejects.toThrow('Guard failed');
    expect(await fs.readFile(path.join(workspace, 'site.css'), 'utf8')).toBe(
      'nav{min-width:900px}'
    );
    review = await restore.review(good, bad, false);
    await expect(
      restore.apply(review.token, good, false, undefined, async () => {
        await fs.writeFile(path.join(workspace, 'site.css'), 'concurrent bytes');
        throw new Error('Guard failed');
      })
    ).rejects.toThrow('preserved');
    expect(await fs.readFile(path.join(workspace, 'site.css'), 'utf8')).toBe('concurrent bytes');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('real rollback preserves unrelated change, checks geometry and supports exact Undo', async () => {
  const { prepareRollback, applyRollback } = await import('../../src/investigation/rollback');
  const { chromium } = await import('playwright-core');
  const net = await import('node:net');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-real-rollback-'));
  try {
    const workspace = path.join(root, 'project');
    await fs.mkdir(workspace);
    const store = new HistoryStore(path.join(root, 'history'));
    await store.open();
    await fs.writeFile(
      path.join(workspace, 'index.html'),
      '<link rel="stylesheet" href="/site.css"><nav>Fixture</nav>'
    );
    await fs.writeFile(
      path.join(workspace, 'server.cjs'),
      "require('http').createServer((q,r)=>{r.setHeader('Content-Type',q.url==='/site.css'?'text/css':'text/html');r.end(require('fs').readFileSync(q.url==='/site.css'?'site.css':'index.html'))}).listen(process.env.PORT,'127.0.0.1')"
    );
    const capture = async (text: string) => {
      await fs.writeFile(path.join(workspace, 'site.css'), text);
      const c = await scan(workspace, store.root);
      return store.commit(c.files, c.contents, 'save', { kind: 'unattributed' });
    };
    const good = await capture('nav{min-width:0px;background:red}');
    const bad = await capture('nav{min-width:900px;background:blue}');
    const latest = await capture('nav{min-width:900px;background:green}');
    const units = declarationChanges(
      'site.css',
      'nav{min-width:0px;background:red}',
      'nav{min-width:900px;background:blue}'
    ).filter((u) => u.property === 'min-width');
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const n = (s.address() as import('node:net').AddressInfo).port;
        s.close(() => resolve(n - 6));
      });
    });
    const config = {
      command: 'node server.cjs',
      port,
      timeoutMs: 3000,
      browserPath: chromium.executablePath(),
      width: 760,
      height: 600
    };
    const candidate = await prepareRollback(
      store,
      latest,
      good,
      bad,
      units,
      config,
      { kind: 'horizontal-overflow', tolerance: 1 },
      [],
      () => false
    );
    const restore = new Restore(workspace, store, defaultLimits);
    const review = await restore.review(candidate.target, latest, false);
    await expect(
      applyRollback(
        restore,
        candidate,
        review.token,
        { ...config, width: 750 },
        () => false,
        () => false
      )
    ).rejects.toThrow('settings');
    const accepted = await applyRollback(
      restore,
      candidate,
      review.token,
      config,
      () => false,
      () => false
    );
    expect(await fs.readFile(path.join(workspace, 'site.css'), 'utf8')).toBe(
      'nav{min-width:0px;background:green}'
    );
    await restore.undo(accepted, false);
    expect(await fs.readFile(path.join(workspace, 'site.css'), 'utf8')).toBe(
      'nav{min-width:900px;background:green}'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60000);
