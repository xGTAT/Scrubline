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
  await expect(page.getByText('Capture arrives with the M1 timeline.')).toBeVisible();
  await expect(page.getByText('Scrubline Harness · v1.139.1')).toBeVisible();
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
