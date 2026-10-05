import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const evidenceDir = resolve(__dirname, '../../../../docs/evidence');

test.beforeAll(() => {
  if (!existsSync(evidenceDir)) mkdirSync(evidenceDir, { recursive: true });
});

test('panel shows an honest empty state', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Scrubline', { exact: true })).toBeVisible();
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  await expect(page.getByText('Open a folder to begin.')).toBeVisible();
  await expect(page.getByText('Scrubline Harness')).toBeVisible();
});

test('panel stays within the UI word budget', async ({ page }) => {
  await page.goto('/');
  const text = (await page.locator('body').innerText()).trim();
  const words = text.split(/\s+/).filter(Boolean);
  expect(words.length).toBeLessThanOrEqual(40);
});

test('panel has no serious accessibility violations', async ({ page }) => {
  await page.goto('/');
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical'
  );
  expect(serious).toEqual([]);
});

test('empty-state evidence screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 640 });
  await page.goto('/');
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/panel_empty_state.png`, fullPage: true });
});

test('sample-web fixture toggles between its two states', async ({ page }) => {
  await page.goto('http://127.0.0.1:4702/');
  // Static HTML loads in the agent-modified state (B10 evidence baseline).
  await expect(page.getByText('State B (Agent Modified)')).toBeVisible();
  // The fixture's JS flag starts at A while the HTML shows B, so the first
  // click lands on "State B (Toggled)"; the second click reaches baseline A.
  await page.getByRole('button', { name: 'Toggle Client State' }).click();
  await expect(page.getByText('State B (Toggled)')).toBeVisible();
  await page.getByRole('button', { name: 'Toggle Client State' }).click();
  await expect(page.getByText('State A (Baseline)')).toBeVisible();
});
for (const status of ['loading', 'error', 'limit', 'ready'] as const) {
  test(`${status} state is accessible, concise and screenshot verified`, async ({ page }) => {
    await page.setViewportSize({ width: 280, height: 640 });
    await page.goto('/');
    await expect(page.getByText('No checkpoints yet')).toBeVisible();
    await page.evaluate((status) => {
      const send = (window as unknown as { __sendTimeline: (value: unknown) => void })
        .__sendTimeline;
      send({
        status,
        unsaved: status === 'ready',
        message:
          status === 'error'
            ? 'Files changed during capture. Retry.'
            : status === 'limit'
              ? 'Capture limit reached. Increase limits.'
              : undefined,
        rows:
          status === 'ready'
            ? [
                {
                  id: 'a'.repeat(64),
                  createdAt: '2026-10-05T15:00:00Z',
                  changedPaths: ['src/index.html', 'src/style.css'],
                  attribution: { kind: 'unattributed' }
                }
              ]
            : []
      });
    }, status);
    await expect(
      page.getByText(
        status === 'loading'
          ? 'Capturing…'
          : status === 'error'
            ? 'Capture failed'
            : status === 'limit'
              ? 'Limit reached'
              : '1 checkpoint',
        { exact: true }
      )
    ).toBeVisible();
    expect((await page.locator('body').innerText()).trim().split(/\s+/).length).toBeLessThanOrEqual(
      40
    );
    expect(
      (await new AxeBuilder({ page }).analyze()).violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical'
      )
    ).toEqual([]);
    if (status === 'ready') {
      await page.getByRole('button', { name: /files changed/ }).click();
      await page.getByText('Changed paths (2)').click();
      await expect(page.getByText('src/index.html')).toBeVisible();
      await expect(page.getByText('Unsaved changes not captured')).toBeVisible();
    }
    await page.screenshot({ path: `${evidenceDir}/panel_m1_${status}.png`, fullPage: true });
  });
}
for (const mode of [
  'preview',
  'rendering',
  'preview-error',
  'review',
  'conflict',
  'undo'
] as const) {
  test(`M2 ${mode} state and keyboard scrub`, async ({ page }) => {
    await page.setViewportSize({ width: 280, height: 740 });
    await page.goto('/');
    await expect(page.getByText('No checkpoints yet')).toBeVisible();
    await page.evaluate((mode) => {
      const send = (window as unknown as { __sendTimeline: (value: unknown) => void })
        .__sendTimeline;
      const rows = [
        {
          id: 'a'.repeat(64),
          createdAt: '2026-10-05T15:00:00Z',
          changedPaths: ['src/index.html'],
          attribution: { kind: 'unattributed' }
        },
        {
          id: 'b'.repeat(64),
          createdAt: '2026-10-05T15:01:00Z',
          changedPaths: ['src/index.html'],
          attribution: { kind: 'unattributed' }
        }
      ];
      send({
        status: 'ready',
        rows,
        unsaved: false,
        canUndo: mode === 'undo',
        preview:
          mode === 'preview'
            ? {
                status: 'ready',
                checkpoint: rows[0].id,
                label: 'Screenshot',
                image:
                  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="960" height="600"%3E%3Crect width="960" height="600" fill="%23303030"/%3E%3C/svg%3E'
              }
            : mode === 'rendering'
              ? { status: 'loading' }
              : mode === 'preview-error'
                ? { status: 'error', message: 'Port busy.' }
                : undefined,
        review:
          mode === 'review' || mode === 'conflict'
            ? {
                token: 'review-token',
                checkpoint: rows[0].id,
                paths: ['src/index.html'],
                conflicts: mode === 'conflict' ? ['src/index.html'] : []
              }
            : undefined
      });
    }, mode);
    await expect(page.getByText('2 checkpoints', { exact: true })).toBeVisible();
    const slider = page.getByRole('slider');
    await slider.focus();
    await page.keyboard.press('End');
    await expect(slider).toHaveValue('1');
    await page.keyboard.press('Home');
    await expect(slider).toHaveValue('0');
    expect((await page.locator('body').innerText()).trim().split(/\s+/).length).toBeLessThanOrEqual(
      40
    );
    expect(
      (await new AxeBuilder({ page }).analyze()).violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical'
      )
    ).toEqual([]);
    if (mode === 'review')
      await expect(page.getByRole('button', { name: 'Confirm restore' })).toBeVisible();
    if (mode === 'conflict')
      await expect(page.getByRole('button', { name: 'Confirm restore' })).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await page.locator('.preview').evaluate((el) => getComputedStyle(el).transitionDuration)
    ).toBe('0s');
    await page.screenshot({ path: `${evidenceDir}/panel_m2_${mode}.png`, fullPage: true });
  });
}
