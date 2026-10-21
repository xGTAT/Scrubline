import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const evidenceDir = resolve(__dirname, '../../../../docs/evidence');

test.beforeAll(() => {
  if (!existsSync(evidenceDir)) mkdirSync(evidenceDir, { recursive: true });
});

const readyWithPages = {
  status: 'ready',
  unsaved: false,
  activePage: 'index.html',
  pages: [
    { route: '/', document: 'index.html' },
    { route: '/about.html', document: 'about.html' },
    { route: '/docs/guide.html', document: 'docs/guide.html' }
  ],
  rows: [
    {
      id: 'a'.repeat(64),
      createdAt: '2026-10-05T15:00:00Z',
      changedPaths: ['index.html'],
      attribution: { kind: 'unattributed' }
    }
  ]
};

test('page dropdown lists discovered pages with the active page selected', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((state) => {
    (window as unknown as { __sendTimeline: (value: unknown) => void }).__sendTimeline(state);
  }, readyWithPages);
  const select = page.locator('#scrubline-page');
  await expect(select).toBeVisible();
  await expect(select.locator('option')).toHaveText([
    'index.html',
    'about.html',
    'docs/guide.html',
    'Add page route…'
  ]);
  await expect(select).toHaveValue('index.html');
});

test('choosing a page posts set-page with the selected document', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((state) => {
    (window as unknown as { __sendTimeline: (value: unknown) => void }).__sendTimeline(state);
  }, readyWithPages);
  await page.locator('#scrubline-page').selectOption('about.html');
  const posted = await page.evaluate(
    () =>
      (window as unknown as { __postedMessages: { type: string; document?: string }[] })
        .__postedMessages
  );
  expect(posted).toContainEqual({ type: 'set-page', document: 'about.html' });
});

test('framework module pages share the app route but select by document', async ({ page }) => {
  const withModules = {
    ...readyWithPages,
    activePage: 'src/App.tsx',
    pages: [
      { route: '/', document: 'index.html' },
      { route: '/', document: 'src/App.tsx' },
      { route: '/', document: 'src/components/Card.tsx' }
    ]
  };
  await page.goto('/');
  await page.evaluate((state) => {
    (window as unknown as { __sendTimeline: (value: unknown) => void }).__sendTimeline(state);
  }, withModules);
  const select = page.locator('#scrubline-page');
  await expect(select).toHaveValue('src/App.tsx');
  await select.selectOption('src/components/Card.tsx');
  const posted = await page.evaluate(
    () =>
      (window as unknown as { __postedMessages: { type: string; document?: string }[] })
        .__postedMessages
  );
  expect(posted).toContainEqual({ type: 'set-page', document: 'src/components/Card.tsx' });
});

test('the add-page option posts add-page instead of a route switch', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((state) => {
    (window as unknown as { __sendTimeline: (value: unknown) => void }).__sendTimeline(state);
  }, readyWithPages);
  await page.locator('#scrubline-page').selectOption('__add__');
  const posted = await page.evaluate(
    () => (window as unknown as { __postedMessages: { type: string }[] }).__postedMessages
  );
  expect(posted).toContainEqual({ type: 'add-page' });
});

test('page dropdown is hidden until pages are known and stays accessible', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#scrubline-page')).toHaveCount(0);
  await page.evaluate((state) => {
    (window as unknown as { __sendTimeline: (value: unknown) => void }).__sendTimeline(state);
  }, readyWithPages);
  await expect(page.locator('#scrubline-page')).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical'
  );
  expect(serious).toEqual([]);
});

test('page dropdown evidence screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 640 });
  await page.goto('/');
  await page.evaluate((state) => {
    (window as unknown as { __sendTimeline: (value: unknown) => void }).__sendTimeline(state);
  }, readyWithPages);
  await expect(page.locator('#scrubline-page')).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/panel_page_select.png`, fullPage: true });
});

test('element review offers page vs sitewide scope and posts the choice', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    (window as unknown as { __sendTimeline: (value: unknown) => void }).__sendTimeline({
      status: 'ready',
      unsaved: false,
      activePage: 'index.html',
      pages: [
        { route: '/', document: 'index.html' },
        { route: '/about.html', document: 'about.html' }
      ],
      rows: [
        {
          id: 'a'.repeat(64),
          createdAt: '2026-10-05T15:00:00Z',
          changedPaths: ['index.html'],
          attribution: { kind: 'unattributed' }
        }
      ],
      review: {
        token: 'scope-token',
        checkpoint: 'a'.repeat(64),
        paths: ['index.html'],
        conflicts: [],
        scope: { selected: 'page', documents: 2 }
      }
    });
  });
  const scope = page.locator('.scope-select');
  await expect(scope).toBeVisible();
  await expect(scope).toContainText('This page only');
  await expect(scope).toContainText('Sitewide (all 2 HTML pages)');
  await scope.getByText('Sitewide (all 2 HTML pages)').click();
  const posted = await page.evaluate(
    () =>
      (window as unknown as { __postedMessages: { type: string; scope?: string }[] })
        .__postedMessages
  );
  expect(posted).toContainEqual({ type: 'selective-scope', scope: 'sitewide' });
  // A review re-published with sitewide selected reflects the choice.
  await page.evaluate(() => {
    (window as unknown as { __sendTimeline: (value: unknown) => void }).__sendTimeline({
      status: 'ready',
      unsaved: false,
      activePage: 'index.html',
      pages: [{ route: '/', document: 'index.html' }],
      rows: [],
      review: {
        token: 'scope-token-2',
        checkpoint: 'a'.repeat(64),
        paths: ['index.html', 'about.html'],
        conflicts: [],
        note: 'Sitewide element change across 2 page(s): index.html, about.html.',
        scope: { selected: 'sitewide', documents: 2 }
      }
    });
  });
  await expect(page.locator('.element-review-note')).toContainText(
    'Sitewide element change across 2 page(s)'
  );
  await expect(page.locator('.scope-select input:checked')).toHaveCount(1);
});

test('scope control stays hidden for single-page workspaces', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    (window as unknown as { __sendTimeline: (value: unknown) => void }).__sendTimeline({
      status: 'ready',
      unsaved: false,
      rows: [],
      review: {
        token: 'scope-token',
        checkpoint: 'a'.repeat(64),
        paths: ['index.html'],
        conflicts: [],
        scope: { selected: 'page', documents: 1 }
      }
    });
  });
  await expect(page.locator('.scope-select')).toHaveCount(0);
});
