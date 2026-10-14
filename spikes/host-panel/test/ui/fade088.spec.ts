import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const images = ['before', 'after'].map(
  (n) =>
    'data:image/png;base64,' +
    readFileSync(`../../fixtures/web-lab-navbar-${n}.png`).toString('base64')
);
for (const reduce of [false, true])
  test(`single-state veil fade swaps only while covered (reduced=${reduce})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
    await page.goto('/');
    await expect(page.getByText('No checkpoints yet')).toBeVisible();
    await page.evaluate((images) => {
      const w = window as unknown as {
        __sendTimeline: (v: unknown) => void;
        __f: (id: string) => void;
      };
      const rows = ['a', 'b'].map((id) => ({
        id,
        createdAt: '2026-10-15T00:00:00Z',
        changedPaths: [],
        attribution: { kind: 'unattributed' }
      }));
      w.__f = (id) =>
        w.__sendTimeline({
          status: 'ready',
          rows,
          selected: id,
          unsaved: false,
          rendered: ['a', 'b'],
          preview: {
            status: 'ready',
            checkpoint: id,
            label: 'Cached screenshot',
            image: images[id === 'a' ? 0 : 1],
            receipt: { imageHash: id, viewport: { width: 960, height: 600 } },
            comparison: { checkpoint: id === 'a' ? 'b' : 'a', regions: [] },
            regions: []
          }
        });
      w.__f('a');
    }, images);
    await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'a');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.evaluate(() => {
      const w = window as unknown as { __f: (id: string) => void };
      const img = document.querySelector('.frame-base')!;
      const veil = document.querySelector('.frame-veil')!;
      (window as unknown as { __swaps: unknown[] }).__swaps = [];
      new MutationObserver(() => {
        (window as unknown as { __swaps: unknown[] }).__swaps.push({
          opacity: Number(getComputedStyle(veil).opacity),
          src: img.getAttribute('src')
        });
      }).observe(img, { attributes: true, attributeFilter: ['src'] });
      w.__f('b');
    });
    await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'b');
    const swaps = await page.evaluate(
      () => (window as unknown as { __swaps: { opacity: number }[] }).__swaps
    );
    expect(swaps).toHaveLength(1);
    if (!reduce) expect(swaps[0].opacity).toBe(1);
    await expect(page.locator('.frame-veil')).toHaveCSS('opacity', '0');
    await expect(page.locator('.frame-base')).toHaveCount(1);
    await expect(page.locator('.frame-veil')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '0 changes', exact: true })).toBeVisible();
    await expect(page.locator('.frame-out,.region')).toHaveCount(0);
    await page.screenshot({ path: `/downloads/scrubline088-fade-${reduce}.png` });
  });
