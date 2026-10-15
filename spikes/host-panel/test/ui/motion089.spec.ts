import { test, expect } from '@playwright/test';
test('only changed screenshot tiles fade, equal pixels stay uncovered and identical frames do not animate', async ({
  page
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 300;
    const ctx = canvas.getContext('2d')!;
    const image = (changed: boolean) => {
      ctx.fillStyle = '#eeeeee';
      ctx.fillRect(0, 0, 480, 300);
      ctx.fillStyle = '#225577';
      ctx.fillRect(20, 20, 120, 40);
      ctx.fillStyle = changed ? '#bb3322' : '#117744';
      ctx.fillRect(300, 180, 48, 36);
      return canvas.toDataURL();
    };
    const images = [image(false), image(true)];
    const w = window as unknown as {
      __sendTimeline: (v: unknown) => void;
      __f: (id: string) => void;
    };
    w.__f = (id) =>
      w.__sendTimeline({
        status: 'ready',
        rows: ['a', 'b', 'c'].map((id) => ({
          id,
          createdAt: '2026-10-15T00:00:00Z',
          changedPaths: [],
          attribution: { kind: 'unattributed' }
        })),
        selected: id,
        unsaved: false,
        rendered: ['a', 'b', 'c'],
        preview: {
          status: 'ready',
          checkpoint: id,
          image: images[id === 'a' ? 0 : 1],
          receipt: { viewport: { width: 480, height: 300 }, imageHash: id },
          comparison: { checkpoint: 'a', regions: [] },
          regions: []
        }
      });
    w.__f('a');
  });
  await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'a');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.evaluate(() => {
    const w = window as unknown as { __f: (id: string) => void; __cover: unknown };
    const veil = document.querySelector('.frame-veil')!;
    new MutationObserver(() => {
      const canvas = veil.querySelector('canvas');
      if (!canvas) return;
      const c = canvas.getContext('2d')!;
      w.__cover = {
        unchangedAlpha: c.getImageData(40, 40, 1, 1).data[3],
        changedAlpha: c.getImageData(310, 190, 1, 1).data[3],
        changedColor: [...c.getImageData(310, 190, 1, 1).data]
      };
    }).observe(veil, { childList: true });
    w.__f('b');
  });
  await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'b');
  expect(await page.evaluate(() => (window as unknown as { __cover: unknown }).__cover)).toEqual({
    unchangedAlpha: 0,
    changedAlpha: 255,
    changedColor: [238, 238, 238, 255]
  });
  await expect(page.locator('.frame-veil')).toHaveCSS('opacity', '0');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __f: (id: string) => void }).__f('c'));
  await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'c');
  expect(await page.locator('.frame-veil').evaluate((e) => e.getAnimations().length)).toBe(0);
  await expect(page.locator('.frame-base')).toHaveCount(1);
  await page.screenshot({ path: '/downloads/scrubline089-local-fade.png' });
});
