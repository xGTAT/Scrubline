import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HistoryStore } from '../../src/store/store';
import { computePerfMetrics, diffPerf } from '../../src/preview/perf';
import type { TrackedFile } from '../../src/bridge/timeline';

const file = (p: string, size: number): TrackedFile => ({
  path: p,
  hash: 'x'.repeat(64),
  size,
  mode: 0o100644
});

test('computePerfMetrics counts DOM elements, CSS rules and asset bytes', () => {
  const html = '<html><body><main><p>One</p><p>Two</p></main></body></html>';
  const css = 'body{margin:0}.a,.b{color:red}@media(min-width:1px){.c{display:none}}';
  const files = [
    file('index.html', html.length),
    file('site.css', css.length),
    file('logo.png', 5000)
  ];
  const contents = new Map([
    ['index.html', Buffer.from(html)],
    ['site.css', Buffer.from(css)],
    ['logo.png', Buffer.alloc(5000)]
  ]);
  const m = computePerfMetrics(files, contents);
  expect(m.htmlBytes).toBe(html.length);
  expect(m.domElements).toBe(6); // html, head(implied), body, main, p, p
  expect(m.cssBytes).toBe(css.length);
  expect(m.cssRules).toBe(3);
  expect(m.assetBytes).toBe(5000);
  expect(m.totalBytes).toBe(html.length + css.length + 5000);
});

test('diffPerf skips zero deltas and reports signed changes', () => {
  const before = {
    htmlBytes: 100,
    domElements: 10,
    cssBytes: 50,
    cssRules: 2,
    assetBytes: 0,
    totalBytes: 150
  };
  const after = {
    htmlBytes: 160,
    domElements: 10,
    cssBytes: 40,
    cssRules: 2,
    assetBytes: 700,
    totalBytes: 900
  };
  const deltas = diffPerf(before, after);
  expect(deltas.find((d) => d.metric === 'domElements')).toBeUndefined();
  expect(deltas.find((d) => d.metric === 'htmlBytes')!.delta).toBe(60);
  expect(deltas.find((d) => d.metric === 'cssBytes')!.delta).toBe(-10);
  expect(deltas.find((d) => d.metric === 'assetBytes')!.delta).toBe(700);
  expect(diffPerf(undefined, after)).toEqual([]);
});

test('store commit attaches perf metrics to the checkpoint manifest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-perf-'));
  try {
    const store = new HistoryStore(path.join(root, 'history'));
    await store.open();
    const html = '<main><section id="a">Hi</section></main>';
    const files = [{ path: 'index.html', hash: '', size: 0, mode: 0o100644 }];
    const bytes = Buffer.from(html);
    const { createHash } = await import('node:crypto');
    files[0].hash = createHash('sha256').update(bytes).digest('hex');
    files[0].size = bytes.length;
    const cp = await store.commit(files, new Map([['index.html', bytes]]), 'save', {
      kind: 'unattributed'
    });
    expect(cp.perf).toBeDefined();
    expect(cp.perf!.domElements).toBe(5); // html, head, body, main, section
    expect(cp.perf!.htmlBytes).toBe(bytes.length);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('render timing sidecar round-trips and rejects invalid values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-timing-'));
  try {
    const store = new HistoryStore(path.join(root, 'history'));
    await store.open();
    expect(await store.renderTimings()).toEqual({});
    await store.recordRenderTiming('cp1', 1234.4);
    await store.recordRenderTiming('cp2', 800);
    await store.recordRenderTiming('cp3', Number.NaN);
    const timings = await store.renderTimings();
    expect(timings.cp1).toBe(1234);
    expect(timings.cp2).toBe(800);
    expect(timings.cp3).toBeUndefined();
    await store.recordRenderTiming('cp1', 2000);
    expect((await store.renderTimings()).cp1).toBe(2000);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
