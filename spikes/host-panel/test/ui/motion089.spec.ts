import { test, expect } from '@playwright/test';
test('continuous full-frame dissolve uses one compositor and finishes exact, including interrupted seeks', async ({
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
    const image = (color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 480, 300);
      return canvas.toDataURL();
    };
    const images = [image('#ff0000'), image('#0000ff'), image('#00ff00')];
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
        preview: { status: 'ready', checkpoint: id, image: images[['a', 'b', 'c'].indexOf(id)] }
      });
    w.__f('a');
  });
  await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'a');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __f: (id: string) => void }).__f('b'));
  await expect(page.locator('.frame-veil canvas')).toHaveCount(1);
  await page.waitForTimeout(65);
  const middle = await page
    .locator('.frame-veil canvas')
    .evaluate((e) => [
      ...(e as HTMLCanvasElement).getContext('2d')!.getImageData(10, 10, 1, 1).data
    ]);
  expect(middle[0]).toBeGreaterThan(0);
  expect(middle[2]).toBeGreaterThan(0);
  expect(middle[3]).toBe(255);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __f: (id: string) => void }).__f('c'));
  await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'c');
  await expect(page.locator('.frame-veil canvas')).toHaveCount(0);
  await expect(page.locator('.frame-out,.region')).toHaveCount(0);
  await expect(page.locator('.frame-base')).toHaveCount(1);
});
test('all six saved alternatives are accessible, not a two-item list', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __sendTimeline: (v: unknown) => void };
    w.__sendTimeline({
      status: 'ready',
      uiMode: 'dev',
      rows: [
        {
          id: 'a',
          createdAt: '2026-10-15T00:00:00Z',
          changedPaths: [],
          attribution: { kind: 'unattributed' }
        }
      ],
      selected: 'a',
      unsaved: false,
      branches: Array.from({ length: 6 }, (_, i) => ({
        id: 'branch-' + i,
        name: 'Studio option ' + (i + 1),
        checkpoint: 'cp-' + i,
        base: 'a',
        directory: '/test/' + i
      }))
    });
  });
  await page.getByText('Alternatives (6)', { exact: true }).click();
  await expect(page.locator('.alternatives-menu li')).toHaveCount(6);
  await expect(page.getByText('Studio option 6', { exact: false })).toBeVisible();
  await expect(
    page.locator('.alternatives-menu').getByRole('button', { name: 'Pick on page', exact: true })
  ).toHaveCount(6);
});

test('Open preview starts the interactive page rather than toggling fullscreen', async ({
  page
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __sent: unknown[];
      acquireVsCodeApi: () => { postMessage: (v: unknown) => void };
    };
    w.__sent = [];
    let api: typeof w.acquireVsCodeApi;
    Object.defineProperty(w, 'acquireVsCodeApi', {
      configurable: true,
      set(value) {
        api = value;
      },
      get() {
        return () => {
          const original = api();
          return {
            ...original,
            postMessage: (message: unknown) => {
              w.__sent.push(message);
              original.postMessage(message);
            }
          };
        };
      }
    });
  });
  await page.goto('/');
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __sendTimeline: (v: unknown) => void };
    w.__sendTimeline({
      status: 'ready',
      rows: [
        {
          id: 'a',
          createdAt: '2026-10-15T00:00:00Z',
          changedPaths: [],
          attribution: { kind: 'unattributed' }
        }
      ],
      selected: 'a',
      unsaved: false,
      preview: {
        status: 'ready',
        checkpoint: 'a',
        image:
          'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="960" height="600"/%3E'
      }
    });
  });
  await page.getByRole('button', { name: 'Open preview', exact: true }).click();
  const sent = await page.evaluate(
    () => (window as unknown as { __sent: { type: string }[] }).__sent
  );
  expect(sent.some((m) => m.type === 'open-preview')).toBe(true);
  expect(sent.some((m) => m.type === 'fullscreen')).toBe(false);
});

test('host-initiated select message updates the local checkpoint while stale acknowledgements do not', async ({
  page
}) => {
  await page.goto('/');
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  const rows = ['a', 'b'].map((id) => ({
    id,
    createdAt: '2026-10-15T00:00:00Z',
    changedPaths: ['index.html'],
    attribution: { kind: 'unattributed' }
  }));
  await page.evaluate((rows) => {
    (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline({
      status: 'ready',
      rows,
      selected: 'a',
      unsaved: false
    });
  }, rows);
  await expect(page.getByRole('slider')).toHaveValue('0');
  await page.evaluate(() =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'select', id: 'b' } }))
  );
  await expect(page.getByRole('slider')).toHaveValue('1');
  await page.evaluate((rows) => {
    (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline({
      status: 'ready',
      rows,
      selected: 'a',
      unsaved: false
    });
  }, rows);
  await expect(page.getByRole('slider')).toHaveValue('1');
});
