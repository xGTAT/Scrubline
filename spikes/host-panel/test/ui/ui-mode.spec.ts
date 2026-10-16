// Standard/Dev presentation switch: same state stream, conditional rendering,
// host-persisted mode restored via the published timeline.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const evidenceDir = resolve(__dirname, '../../../../docs/evidence');

test.beforeAll(() => {
  if (!existsSync(evidenceDir)) mkdirSync(evidenceDir, { recursive: true });
});

const row = {
  id: 'a'.repeat(64),
  createdAt: '2026-10-17T09:00:00Z',
  changedPaths: ['index.html'],
  attribution: { kind: 'unattributed' }
};
const second = { ...row, id: 'b'.repeat(64), createdAt: '2026-10-17T09:05:00Z' };

const devOnlyMarkers = ['UI Advisor Chatbot', 'Fork checkpoint', 'Scrubline Harness'] as const;

test('standard mode is the default: core controls present, dev diagnostics absent', async ({
  page
}) => {
  await page.goto('/');
  await page.evaluate(
    (r) => (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline(r),
    { status: 'ready', rows: [row, second], unsaved: false, selected: second.id }
  );
  await expect(page.locator('.panel')).toHaveAttribute('data-mode', 'standard');
  await expect(page.getByRole('button', { name: 'Standard', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  // Everyday surface: status, scrub, preview, review, changed paths.
  await expect(page.getByText('2 checkpoints', { exact: true })).toBeVisible();
  await expect(page.getByRole('slider')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review restore', exact: true })).toBeVisible();
  await expect(page.getByText('Changed paths (1)', { exact: true })).toBeVisible();
  // No dev diagnostics, no multi-select checkboxes.
  for (const marker of devOnlyMarkers)
    await expect(page.getByText(marker, { exact: false })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
});

test('toggling Dev reveals the advanced surface and posts set-ui-mode both ways', async ({
  page
}) => {
  await page.goto('/');
  await page.evaluate(
    (r) => (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline(r),
    { status: 'ready', rows: [row, second], unsaved: false, selected: second.id }
  );
  await page.getByRole('button', { name: 'Dev', exact: true }).click();
  await expect(page.locator('.panel')).toHaveAttribute('data-mode', 'dev');
  await expect(page.getByText('UI Advisor Chatbot', { exact: true })).toBeVisible();
  await expect(page.getByText('Fork checkpoint', { exact: true })).toBeVisible();
  // The timeline shows one focused card at a time, so one checkbox is present.
  await expect(page.getByRole('checkbox')).toHaveCount(1);
  await page.getByRole('button', { name: 'Standard', exact: true }).click();
  await expect(page.locator('.panel')).toHaveAttribute('data-mode', 'standard');
  await expect(page.getByText('UI Advisor Chatbot', { exact: true })).toHaveCount(0);
  const posted = await page.evaluate(
    () =>
      (window as unknown as { __postedMessages: { type: string; mode?: string }[] })
        .__postedMessages
  );
  expect(posted.filter((m) => m.type === 'set-ui-mode').map((m) => m.mode)).toEqual([
    'dev',
    'standard'
  ]);
});

test('a host-published uiMode restores without any toggle click', async ({ page }) => {
  await page.goto('/');
  // Simulates globalState returning 'dev': the host publishes it with the timeline.
  await page.evaluate(
    (r) => (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline(r),
    { status: 'ready', uiMode: 'dev', rows: [row, second], unsaved: false }
  );
  await expect(page.locator('.panel')).toHaveAttribute('data-mode', 'dev');
  await expect(page.getByRole('button', { name: 'Dev', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.getByText('UI Advisor Chatbot', { exact: true })).toBeVisible();
});

test('standard mode offers a compact render action that drives the same messages', async ({
  page
}) => {
  await page.goto('/');
  await page.evaluate(
    (r) => (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline(r),
    { status: 'ready', rows: [row, second], unsaved: false, rendered: [] }
  );
  const quick = page.getByRole('region', { name: 'Render history' });
  await expect(quick).toBeVisible();
  // The full render toolset stays out of Standard.
  await expect(page.locator('.render-controls')).toHaveCount(0);
  await quick.getByRole('button', { name: 'Render history', exact: true }).click();
  const posted = await page.evaluate(
    () => (window as unknown as { __postedMessages: { type: string }[] }).__postedMessages
  );
  expect(posted.at(-1)).toEqual({ type: 'render-history' });
  // Progress and cancel surface inline while the host renders.
  await page.evaluate(
    (r) =>
      (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline({
        ...r,
        rendering: { running: true, done: 1, total: 2, failed: 0 }
      }),
    { status: 'ready', rows: [row, second], unsaved: false, rendered: [] }
  );
  await expect(page.getByText('Rendering 1/2…')).toBeVisible();
  await quick.getByRole('button', { name: 'Cancel', exact: true }).click();
  const after = await page.evaluate(
    () => (window as unknown as { __postedMessages: { type: string }[] }).__postedMessages
  );
  expect(after.at(-1)).toEqual({ type: 'cancel-render' });
  // Once every checkpoint is rendered the quick action disappears again.
  await page.evaluate(
    (r) => (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline(r),
    { status: 'ready', rows: [row, second], unsaved: false, rendered: [row.id, second.id] }
  );
  await expect(page.getByRole('region', { name: 'Render history' })).toHaveCount(0);
});

test('standard mode stays concise, accessible and screenshot verified with rows', async ({
  page
}) => {
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto('/');
  await page.evaluate(
    (r) => (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline(r),
    { status: 'ready', rows: [row, second], unsaved: false, rendered: [row.id, second.id] }
  );
  const text = (await page.locator('body').innerText()).trim();
  expect(text.split(/\s+/).length).toBeLessThanOrEqual(40);
  const serious = (await new AxeBuilder({ page }).analyze()).violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical'
  );
  expect(serious).toEqual([]);
  await page.screenshot({ path: `${evidenceDir}/panel_standard_mode.png`, fullPage: true });
  await page.getByRole('button', { name: 'Dev', exact: true }).click();
  await page.screenshot({ path: `${evidenceDir}/panel_dev_mode.png`, fullPage: true });
});
