import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const tallImage =
  'data:image/png;base64,' +
  readFileSync(`../../fixtures/web-lab-navbar-before.png`).toString('base64');
const shortImage =
  'data:image/png;base64,' +
  readFileSync('../../fixtures/web-lab-short-page.png').toString('base64');

for (const [name, image] of [
  ['tall', tallImage],
  ['short', shortImage]
] as const)
  for (const count of [0, 1, 12, 120]) {
    test(`changes badge stays inside the frame at narrow width (${name}, count=${count})`, async ({
      page
    }) => {
      await page.setViewportSize({ width: 590, height: 900 });
      await page.goto('/');
      await page.evaluate(
        ({ image, regions, height }) => {
          const w = window as unknown as { __sendTimeline: (v: unknown) => void };
          w.__sendTimeline({
            status: 'ready',
            rows: [
              {
                id: 'a',
                createdAt: '2026-10-15T00:00:00Z',
                changedPaths: [],
                attribution: { kind: 'unattributed' }
              },
              {
                id: 'b',
                createdAt: '2026-10-15T01:00:00Z',
                changedPaths: [],
                attribution: { kind: 'unattributed' }
              }
            ],
            selected: 'b',
            unsaved: false,
            rendered: ['a', 'b'],
            preview: {
              status: 'ready',
              checkpoint: 'b',
              label: 'Cached screenshot',
              image,
              receipt: {
                imageHash: 'b',
                viewport: { width: 960, height }
              },
              comparison: { checkpoint: 'a', regions },
              regions: []
            }
          });
        },
        {
          image,
          regions: Array.from({ length: count }, (_, i) => ({
            key: `r${i}`,
            signature: `s${i}`,
            x: (i % 10) * 90,
            y: Math.floor(i / 10) * 45,
            width: 60,
            height: 30
          }))
        }
      );
      await page.screenshot({ path: `/downloads/badge-${name}-${count}.png`, fullPage: true });
      const badge = page.locator('.highlight-controls');
      await expect(badge).toBeVisible();
      const img = await page.locator('.frame').boundingBox();
      const box = await badge.boundingBox();
      expect(box).toBeTruthy();
      expect(img).toBeTruthy();
      const intersects = (
        a: { x: number; y: number; width: number; height: number },
        b: { x: number; y: number; width: number; height: number }
      ) =>
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      // The badge must live outside the frame figure entirely.
      expect(intersects(box!, img!)).toBe(false);
      // So must the read-only caption.
      const caption = await page.locator('.frame-caption').boundingBox();
      expect(caption).toBeTruthy();
      expect(intersects(caption!, img!)).toBe(false);
      // The badge stays within the panel width.
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(590);
    });
  }
