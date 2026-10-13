import { test, expect } from 'vitest';
import { chromium } from 'playwright-core';
import { checkGeometry } from '../../src/layout/collect';
import { validateSweep, validateGuard } from '../../src/layout/types';
import { sweep } from '../../src/layout/sweep';
import type { Checkpoint } from '../../src/bridge/timeline';
test('geometry detects seeded narrow width failure using full unclipped bounds and refuses ambiguous selectors', async () => {
  const browser = await chromium.launch({
    executablePath: chromium.executablePath(),
    headless: true
  });
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 600 } });
    await page.setContent(
      '<style>body{margin:0} #container{width:100%;height:100px} #target{width:100%;height:50px}@media(min-width:742px) and (max-width:781px){#target{width:900px}}</style><div id="container"><div id="target"></div></div>'
    );
    const guard = {
      kind: 'containment' as const,
      selector: '#target',
      container: '#container',
      tolerance: 1
    };
    expect((await checkGeometry(page, guard)).outcome).toBe('fail');
    expect(
      (await checkGeometry(page, { kind: 'horizontal-overflow', tolerance: 1 })).measured
    ).toBe(140);
    await page.setViewportSize({ width: 800, height: 600 });
    expect((await checkGeometry(page, guard)).outcome).toBe('pass');
    expect((await checkGeometry(page, { ...guard, selector: 'div' })).outcome).toBe('unknown');
    expect((await checkGeometry(page, { ...guard, selector: '#missing' })).outcome).toBe('unknown');
    expect((await checkGeometry(page, { ...guard, selector: '[' })).outcome).toBe('unknown');
    await page.setContent(
      '<style>body{margin:0}#container{width:100px;overflow:auto}#target{width:900px}</style><div id="container"><div id="target">scroll</div></div>'
    );
    expect((await checkGeometry(page, { kind: 'horizontal-overflow', tolerance: 1 })).outcome).toBe(
      'pass'
    );
  } finally {
    await browser.close();
  }
}, 20000);
test('sweep validates bounds and cancellation leaves untested cells unknown', async () => {
  expect(() => validateSweep([390, 390], ['a'])).toThrow();
  expect(() => validateSweep([390], [])).toThrow();
  expect(() => validateGuard({ kind: 'containment', tolerance: 1 })).toThrow();
  expect(() => validateGuard({ kind: 'horizontal-overflow', tolerance: NaN })).toThrow();
  let cancel = false;
  const notifications: number[] = [];
  const result = await sweep(
    [{ id: 'a' } as Checkpoint],
    [390, 760],
    async (c) => {
      cancel = true;
      return {
        result: {
          version: 1,
          checkpoint: c.id,
          specification: 'spec',
          guard: { kind: 'horizontal-overflow', tolerance: 1 },
          outcome: 'pass',
          message: 'checked'
        }
      };
    },
    () => cancel,
    (s) => notifications.push(s.done)
  );
  expect(result.cancelled).toBe(true);
  expect(result.cells).toHaveLength(0);
  expect(result.done).toBe(0);
  expect(notifications).toEqual([0, 0]);
});
