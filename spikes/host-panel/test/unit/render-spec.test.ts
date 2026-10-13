import { test, expect } from 'vitest';
import { specification, specificationKey, identifyBrowser } from '../../src/preview/spec';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
const base = { command: 'node server', port: 4100, timeoutMs: 5000 };
test('specification defaults and rejects invalid dimensions and escaping routes', () => {
  expect(specification(base)).toEqual({ width: 960, height: 600, route: '/', readySelector: '' });
  for (const route of ['https://evil.invalid', '//evil.invalid', '/\\evil.invalid', '/#hash'])
    expect(() => specification({ ...base, route })).toThrow();
  for (const width of [0, 240.5, 4000, NaN])
    expect(() => specification({ ...base, width })).toThrow();
  expect(specification({ ...base, route: '/view?state=b' }).route).toBe('/view?state=b');
});
test('cache identity varies with viewport route readiness and browser identity, not port', () => {
  const original = specificationKey(base);
  for (const change of [
    { width: 390 },
    { height: 844 },
    { route: '/other' },
    { readySelector: '#ready' },
    { browserIdentity: 'new' }
  ])
    expect(specificationKey({ ...base, ...change })).not.toBe(original);
  expect(specificationKey({ ...base, port: 4101 })).toBe(original);
});
test('browser executable bytes bind identity without exposing the path in receipts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-browser-'));
  try {
    const file = path.join(directory, 'browser');
    await fs.writeFile(file, 'first');
    const a = await identifyBrowser({ ...base, browserPath: file });
    await fs.writeFile(file, 'second');
    const b = await identifyBrowser({ ...base, browserPath: file });
    expect(a.browserIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(a.browserIdentity).not.toBe(b.browserIdentity);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('repeatability is bounded and never equates unmatched specifications', async () => {
  const { repeatability } = await import('../../src/preview/repeatability');
  const probe = {
    checkpoint: 'a',
    specification: 's',
    imageHash: 'i',
    geometryHash: 'g'
  } as import('../../src/evidence/types').RenderReceipt;
  expect(repeatability([probe, { ...probe }])).toBe('repeatable-in-two-probes');
  expect(repeatability([probe, { ...probe, imageHash: 'different' }])).toBe('unstable');
  expect(() => repeatability([probe])).toThrow();
  expect(() => repeatability([probe, { ...probe, specification: 'other' }])).toThrow();
});
