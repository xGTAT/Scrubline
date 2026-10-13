import { test, expect } from 'vitest';
import { declarationChanges, applyUnits } from '../../src/investigation/change-units';
import { minimize } from '../../src/investigation/minimize';
import { ancestry } from '../../src/investigation/history';
import type { Checkpoint } from '../../src/bridge/timeline';
test('CSS value units preserve unrelated bytes and refuse structural or shared ownership', () => {
  const before = 'body { min-width: 0px; color: red; }',
    after = 'body { min-width: 900px; color: blue; }';
  const units = declarationChanges('site.css', before, after);
  expect(units).toHaveLength(2);
  expect(applyUnits(before, [units[0]])).toBe('body { min-width: 900px; color: red; }');
  expect(() => declarationChanges('x.css', before, after + 'p{color:red}')).toThrow();
  expect(() =>
    declarationChanges('x.css', 'p{color:red;color:blue}', 'p{color:black;color:white}')
  ).toThrow('Duplicate');
  expect(() => declarationChanges('x.css', 'p{color:var(--x)}', 'p{color:var(--y)}')).toThrow(
    'Shared'
  );
  expect(() => applyUnits('body { min-width: 1px; color: red; }', [units[0]])).toThrow('base');
});
test('bounded minimization handles interacting rules, unknown and cancellation honestly', async () => {
  const result = await minimize(
    ['a', 'b', 'noise'],
    async (s) => (s.includes('a') && s.includes('b') ? 'fail' : 'pass'),
    16
  );
  expect(result.units).toEqual(['a', 'b']);
  expect(result.minimal).toBe(true);
  expect((await minimize(['a', 'b'], async () => 'unknown', 2)).minimal).toBe(false);
  expect((await minimize(['a', 'b', 'c'], async () => 'pass', 1)).minimal).toBe(false);
  expect(
    (
      await minimize(
        ['a'],
        async () => 'pass',
        2,
        () => true
      )
    ).cancelled
  ).toBe(true);
});
test('ancestry respects actual parent links and refuses reversed or distant choices', () => {
  const cps = [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'b' }
  ] as Checkpoint[];
  expect(ancestry(cps, 'a', 'c').map((c) => c.id)).toEqual(['a', 'b', 'c']);
  expect(() => ancestry(cps, 'c', 'a')).toThrow();
});

test('real static CSS investigation isolates overflow while original files stay untouched', async () => {
  const fs = await import('node:fs/promises'),
    path = await import('node:path'),
    os = await import('node:os'),
    net = await import('node:net');
  const { HistoryStore } = await import('../../src/store/store');
  const { scan, defaultLimits } = await import('../../src/capture/scanner');
  const { chromium } = await import('playwright-core');
  const { investigate } = await import('../../src/investigation/run');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-investigation-test-'));
  try {
    const workspace = path.join(directory, 'project');
    await fs.mkdir(workspace);
    const store = new HistoryStore(path.join(directory, 'history'));
    await store.open();
    await fs.writeFile(
      path.join(workspace, 'index.html'),
      '<link rel="stylesheet" href="/site.css"><h1>Fixture</h1>'
    );
    await fs.writeFile(
      path.join(workspace, 'server.cjs'),
      "require('http').createServer((q,r)=>{r.setHeader('Content-Type',q.url==='/site.css'?'text/css':'text/html');r.end(require('fs').readFileSync(q.url==='/site.css'?'site.css':'index.html'))}).listen(process.env.PORT,'127.0.0.1')"
    );
    const capture = async () => {
      const s = await scan(workspace, store.root);
      return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    };
    await fs.writeFile(
      path.join(workspace, 'site.css'),
      'body { margin: 0; min-width: 0px; color: red; }'
    );
    const good = await capture();
    const badCss = 'body { margin: 0; min-width: 900px; color: blue; }';
    await fs.writeFile(path.join(workspace, 'site.css'), badCss);
    const bad = await capture();
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as import('node:net').AddressInfo).port;
        s.close(() => resolve(p - 5));
      });
    });
    const result = await investigate(
      store,
      {
        command: 'node server.cjs',
        port,
        timeoutMs: 3000,
        browserPath: chromium.executablePath(),
        width: 760,
        height: 600
      },
      defaultLimits,
      {
        good: good.id,
        bad: bad.id,
        budget: 8,
        guard: { kind: 'horizontal-overflow', tolerance: 1 }
      },
      () => false,
      () => {}
    );
    expect(result.message).toMatch(/1-minimal/);
    expect(result.units).toHaveLength(1);
    expect(result.units[0].property).toBe('min-width');
    expect(result.trials).toHaveLength(result.probes);
    expect(result.trials?.some((t) => t.subset?.length === 1 && t.outcome === 'fail')).toBe(true);
    expect(await fs.readFile(path.join(workspace, 'site.css'), 'utf8')).toBe(badCss);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 60000);
