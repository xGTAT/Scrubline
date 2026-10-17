import { test, expect } from '@playwright/test';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const evidenceDir = resolve(__dirname, '../../../../docs/evidence');
const ID = 'a'.repeat(64);

test.beforeAll(() => {
  if (!existsSync(evidenceDir)) mkdirSync(evidenceDir, { recursive: true });
});

const timeline = {
  status: 'ready',
  unsaved: false,
  selected: ID,
  rows: [
    {
      id: ID,
      createdAt: new Date('2026-10-16T17:00:00Z').toISOString(),
      changedPaths: ['server.js'],
      attribution: { kind: 'unattributed' }
    }
  ],
  preview: {
    status: 'ready',
    checkpoint: ID,
    label: 'Rendered evidence - not rechecked',
    image: '/fixtures/web-lab-short-page.png',
    regions: []
  },
  backend: {
    status: 'ready',
    checkpoint: ID,
    capture: {
      version: 1,
      checkpoint: ID,
      specification: 'spec',
      capturedAt: '2026-10-16T17:00:01Z',
      pageHost: '127.0.0.1:4100',
      truncated: false,
      coverage: [
        'Browser-observed requests during this render only; not evidence of server-side or database behavior.',
        'Query values, headers, cookies and bodies are never recorded.'
      ],
      entries: [
        {
          method: 'GET',
          host: '127.0.0.1:4100',
          path: '/',
          queryKeys: [],
          status: 200,
          resourceType: 'document',
          startedAt: 0,
          durationMs: 42,
          sameOrigin: true,
          mutation: false
        },
        {
          method: 'GET',
          host: '127.0.0.1:4100',
          path: '/api/status',
          queryKeys: ['verbose'],
          status: 200,
          resourceType: 'fetch',
          startedAt: 55,
          durationMs: 18,
          sameOrigin: true,
          mutation: false
        },
        {
          method: 'POST',
          host: '127.0.0.1:4100',
          path: '/api/items',
          queryKeys: [],
          status: 201,
          resourceType: 'fetch',
          startedAt: 80,
          durationMs: 61,
          sameOrigin: true,
          mutation: true
        },
        {
          method: 'GET',
          host: '127.0.0.1:4100',
          path: '/api/missing',
          queryKeys: [],
          status: 404,
          resourceType: 'fetch',
          startedAt: 150,
          durationMs: 12,
          sameOrigin: true,
          mutation: false
        },
        {
          method: 'GET',
          host: 'cdn.example.net',
          path: '/lib.js',
          queryKeys: [],
          status: 200,
          resourceType: 'script',
          startedAt: 20,
          durationMs: 90,
          sameOrigin: false,
          mutation: false
        }
      ]
    },
    matches: [-1, 0, 1, -1, -1],
    endpoints: {
      framework: 'express',
      scannedFiles: 2,
      notes: ['Dynamically registered or non-literal routes exist and are not listed.'],
      routes: [
        { method: 'GET', path: '/api/status', file: 'server.js', line: 12 },
        { method: 'POST', path: '/api/items', file: 'server.js', line: 18 },
        { method: 'GET', path: '/api/items/:id', file: 'routes/items.js', line: 4 }
      ]
    },
    graph: {
      nodes: ['server.js', 'routes/items.js', 'db.js'],
      edges: [
        { from: 'server.js', to: 'routes/items.js' },
        { from: 'routes/items.js', to: 'db.js' }
      ],
      external: ['express'],
      scannedFiles: 3,
      truncated: false
    },
    diff: [{ key: 'POST 127.0.0.1:4100/api/items', kind: 'added', after: '201' }]
  }
};

async function openBackend(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(
    ({ timeline, id }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      w.__sendTimeline(timeline);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'select', id } }));
      w.__sendTimeline(timeline);
    },
    { timeline, id: ID }
  );
  const panel = page.locator('details.backend-panel');
  await expect(panel).toBeVisible();
  await panel.locator('> summary').click();
}

test('backend panel renders waterfall, routes, graph and honest labels', async ({ page }) => {
  await openBackend(page);
  await expect(page.locator('.bv-path', { hasText: '/api/status' }).first()).toBeVisible();
  await expect(page.locator('.bv-path', { hasText: '/api/items' }).first()).toBeVisible();
  await expect(page.locator('.bv-mutation-note')).toBeVisible();
  await expect(page.locator('.bv-note', { hasText: 'never recorded' })).toBeVisible();
  // Query key names render, values never do.
  await expect(page.locator('.bv-query', { hasText: 'verbose' })).toBeVisible();
  // Static-structure labels, no runtime-flow claims.
  await page.locator('details.bv-section summary').first().click();
  await expect(page.locator('.bv-endpoint-file-name', { hasText: 'server.js' })).toBeVisible();
  await expect(page.locator('.bv-note', { hasText: 'Statically detected' })).toBeVisible();
  await page.locator('details.bv-section summary').last().click();
  await expect(page.locator('.bv-note', { hasText: 'Static import structure' })).toBeVisible();
  // Diff vs previous checkpoint.
  await expect(page.locator('.bv-diff-header')).toBeVisible();
  // Waterfall bars: mutation stroke on the POST bar.
  await expect(page.locator('.bv-bar.mutation')).toHaveCount(1);
  await expect(page.locator('.bv-bar')).toHaveCount(5);
});

test('backend panel evidence screenshots wide and narrow', async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 900 });
  await openBackend(page);
  await page.locator('details.bv-section summary').first().click();
  await page.locator('details.bv-section summary').last().click();
  // Viewport screenshots: fullPage stitching misdraws the sticky scrub bar.
  await page.locator('details.backend-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidenceDir}/backend_panel_wide.png`, fullPage: false });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator('details.backend-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${evidenceDir}/backend_panel_narrow.png`, fullPage: false });
  // No real overlap: scrub controls sit above the backend panel in flow.
  const boxes = await page.evaluate(() => {
    const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    return { scrub: rect('.scrub'), backend: rect('details.backend-panel') };
  });
  expect(boxes.backend.top).toBeGreaterThanOrEqual(boxes.scrub.top);
  // Narrow: waterfall stays inside the panel, no horizontal page scroll.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
