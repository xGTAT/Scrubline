import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const images = ['before', 'after'].map(
  (n) =>
    'data:image/png;base64,' +
    readFileSync(`../../fixtures/web-lab-navbar-${n}.png`).toString('base64')
);
test('web-lab frames swap decoded images without ghost layers at slow, button, play and interrupted speeds', async ({
  page
}) => {
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto('/');
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  await page.evaluate((images) => {
    const rows = ['a', 'b', 'c'].map((id, i) => ({
      id,
      createdAt: `2026-10-15T00:0${i}:00Z`,
      changedPaths: [],
      attribution: { kind: 'unattributed' }
    }));
    const w = window as unknown as {
      __sendTimeline: (v: unknown) => void;
      __f: (id: string) => void;
      acquireVsCodeApi: unknown;
    };
    w.__f = (id) =>
      w.__sendTimeline({
        status: 'ready',
        rows,
        selected: id,
        unsaved: false,
        rendered: ['a', 'b', 'c'],
        preview: {
          status: 'ready',
          checkpoint: id,
          image: images[id === 'b' ? 1 : 0],
          label: 'Cached screenshot',
          regions: [
            { key: 'nav', signature: id, x: 8, y: 8, width: 744, height: id === 'b' ? 148 : 88 }
          ]
        }
      });
    w.__f('a');
    window.addEventListener('scrub-test-frame', ((e: CustomEvent<string>) =>
      w.__f(e.detail)) as EventListener);
  }, images);
  await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'a');
  await page.waitForTimeout(250);
  const transition = async (id: string, label: string) => {
    await page.evaluate(
      (id) => window.dispatchEvent(new CustomEvent('scrub-test-frame', { detail: id })),
      id
    );
    await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', id);
    await expect(page.locator('.frame-out')).toHaveCount(0);
    await expect(page.locator('.region')).toHaveCount(0);
    await expect(page.locator('.frame-base')).toHaveAttribute('src', images[id === 'b' ? 1 : 0]);
    await page.screenshot({ path: `/downloads/scrubline087-pixels-${label}.png` });
    await page.waitForTimeout(260);
  };
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await transition('b', 'next');
  await page.getByRole('button', { name: 'Prev', exact: true }).click();
  await transition('a', 'prev');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(720);
  await transition('b', 'play');
  await page.getByRole('slider').fill('1');
  await page.getByRole('slider').fill('0');
  await transition('a', 'slow');
  for (let i = 0; i < 8; i++) {
    await page.getByRole('slider').fill(String(i % 2));
    await page.evaluate(
      (id) => window.dispatchEvent(new CustomEvent('scrub-test-frame', { detail: id })),
      i % 2 ? 'b' : 'a'
    );
    await page.waitForTimeout(65);
  }
  await page.waitForTimeout(300);
  await expect(page.locator('.frame-out')).toHaveCount(0);
  await expect(page.locator('.region')).toHaveCount(0);
});
