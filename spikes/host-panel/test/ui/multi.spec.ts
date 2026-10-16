// Multi-checkpoint selection tray, review table and conflict blocking.
import { test, expect } from '@playwright/test';

const id = (c: string) => c.repeat(64);
const rows = [
  {
    id: id('a'),
    createdAt: '2026-10-16T10:00:00Z',
    changedPaths: ['index.html'],
    attribution: { kind: 'unattributed' }
  },
  {
    id: id('b'),
    createdAt: '2026-10-16T10:05:00Z',
    changedPaths: ['site.css'],
    attribution: { kind: 'unattributed' }
  },
  {
    id: id('c'),
    createdAt: '2026-10-16T10:10:00Z',
    changedPaths: ['index.html'],
    attribution: { kind: 'unattributed' }
  }
];
const ready = { status: 'ready', rows, unsaved: false };

async function openPanel(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(
    (r) => (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline(r),
    ready
  );
}

// The panel shows one focused card at a time; select moves the focus.
async function focusRow(page: import('@playwright/test').Page, rowId: string) {
  await page.evaluate(
    (rowId2) =>
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'select', id: rowId2 } })),
    rowId
  );
}

async function tick(page: import('@playwright/test').Page, rowId: string) {
  await focusRow(page, rowId);
  await page.getByRole('checkbox', { name: `Select checkpoint ${rowId.slice(0, 8)}` }).click();
}

test('checkboxes build an ordered selection tray that posts set-selection', async ({ page }) => {
  await openPanel(page);
  await tick(page, id('c'));
  await tick(page, id('a'));
  const tray = page.getByRole('region', { name: 'Selected checkpoints' });
  await expect(tray).toContainText('2 selected');
  // Timeline order, oldest first, not click order.
  const chips = tray.locator('ol li code');
  await expect(chips.first()).toHaveText(id('a').slice(0, 8));
  await expect(chips.nth(1)).toHaveText(id('c').slice(0, 8));
  const posted = await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown[] }).__postedMessages
  );
  const sets = posted.filter((m) => (m as { type: string }).type === 'set-selection');
  expect(sets.at(-1)).toEqual({ type: 'set-selection', ids: [id('a'), id('c')], mode: 'combine' });
});

test('review button posts review-multi with the chosen mode', async ({ page }) => {
  await openPanel(page);
  await tick(page, id('a'));
  await tick(page, id('b'));
  const tray = page.getByRole('region', { name: 'Selected checkpoints' });
  await tray.getByLabel('Apply mode').selectOption('revert');
  await tray.getByRole('button', { name: 'Review 2 checkpoints' }).click();
  const posted = await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown[] }).__postedMessages
  );
  expect(posted.at(-1)).toEqual({ type: 'review-multi', ids: [id('a'), id('b')], mode: 'revert' });
});

test('clear empties the selection and hides the tray', async ({ page }) => {
  await openPanel(page);
  await tick(page, id('a'));
  const tray = page.getByRole('region', { name: 'Selected checkpoints' });
  await tray.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByRole('region', { name: 'Selected checkpoints' })).toHaveCount(0);
});

test('composition conflicts block confirm and show the per-file table', async ({ page }) => {
  await openPanel(page);
  const injected = {
    ...ready,
    review: {
      token: 'tok',
      checkpoint: id('f'),
      paths: ['index.html'],
      conflicts: [] as string[],
      multi: {
        mode: 'combine',
        sources: [id('a'), id('c')],
        decisions: [
          {
            path: 'index.html',
            sources: [id('a'), id('c')],
            status: 'conflict',
            reason: 'index.html: changed on both sides of checkpoint cccccccc.'
          },
          { path: 'site.css', sources: [id('b')], status: 'clean' }
        ],
        warnings: [] as string[],
        hints: [] as unknown[],
        blocked: ['index.html'],
        compositionId: 'e'.repeat(64)
      }
    },
    selection: { ids: [id('a'), id('c')], mode: 'combine' }
  };
  await page.evaluate(
    (r) => (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline(r),
    injected
  );
  const review = page.getByRole('region', { name: 'Restore confirmation' });
  await expect(review).toContainText('Composition conflicts block apply');
  await expect(review).toContainText('changed on both sides');
  await expect(review.getByRole('button', { name: 'Confirm combined apply' })).toBeDisabled();
});

test('dependency hint offers a one-click add that re-reviews with the hint id', async ({
  page
}) => {
  await openPanel(page);
  const injected = {
    ...ready,
    review: {
      token: 'tok',
      checkpoint: id('f'),
      paths: ['index.html'],
      conflicts: [] as string[],
      multi: {
        mode: 'combine',
        sources: [id('a')],
        decisions: [{ path: 'index.html', sources: [id('a')], status: 'clean' }],
        warnings: [] as string[],
        hints: [{ missing: id('c'), neededBy: id('a'), path: 'index.html' }],
        blocked: [] as string[],
        compositionId: 'e'.repeat(64)
      }
    },
    selection: { ids: [id('a')], mode: 'combine' }
  };
  await page.evaluate(
    (r) => (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline(r),
    injected
  );
  const review = page.getByRole('region', { name: 'Restore confirmation' });
  await review.getByRole('button', { name: `Add ${id('c').slice(0, 8)}` }).click();
  const posted = await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown[] }).__postedMessages
  );
  const reReview = posted.filter((m) => (m as { type: string }).type === 'review-multi').at(-1);
  expect(reReview.ids).toEqual([id('a'), id('c')]);
});

test('mosaic mode offers per-file winner selects posting overrides', async ({ page }) => {
  await openPanel(page);
  const injected = {
    ...ready,
    selection: { ids: [id('a'), id('c')], mode: 'mosaic' },
    review: {
      token: 'tok',
      checkpoint: id('f'),
      paths: ['index.html'],
      conflicts: [] as string[],
      multi: {
        mode: 'mosaic',
        sources: [id('a'), id('c')],
        decisions: [{ path: 'index.html', sources: [id('a'), id('c')], status: 'unchanged' }],
        warnings: [] as string[],
        hints: [] as unknown[],
        blocked: [] as string[],
        overrides: {} as Record<string, string>,
        compositionId: 'e'.repeat(64)
      }
    }
  };
  await page.evaluate(
    (r) => (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline(r),
    injected
  );
  await page.getByLabel('Source for index.html').selectOption(id('a'));
  const posted = await page.evaluate(
    () => (window as unknown as { __postedMessages: unknown[] }).__postedMessages
  );
  const reReview = posted.filter((m) => (m as { type: string }).type === 'review-multi').at(-1);
  expect(reReview.mode).toBe('mosaic');
  expect(reReview.overrides).toEqual({ 'index.html': id('a') });
});

test('shift+arrow extends the selection from the anchor and moves focus', async ({ page }) => {
  await openPanel(page);
  await tick(page, id('a'));
  // Focus moves with select; shift+arrow on the focused checkbox extends the range.
  const boxA = page.getByRole('checkbox', { name: `Select checkpoint ${id('a').slice(0, 8)}` });
  await boxA.focus();
  await page.keyboard.press('Shift+ArrowDown');
  const tray = page.getByRole('region', { name: 'Selected checkpoints' });
  await expect(tray).toContainText('2 selected');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(tray).toContainText('3 selected');
  const chips = tray.locator('ol li code');
  await expect(chips.first()).toHaveText(id('a').slice(0, 8));
  await expect(chips.nth(1)).toHaveText(id('b').slice(0, 8));
  await expect(chips.nth(2)).toHaveText(id('c').slice(0, 8));
});

test('changing the tray after review disables confirm until re-reviewed', async ({ page }) => {
  await openPanel(page);
  const injected = {
    ...ready,
    selection: { ids: [id('a')], mode: 'combine' },
    review: {
      token: 'tok',
      checkpoint: id('f'),
      paths: ['index.html'],
      conflicts: [] as string[],
      multi: {
        mode: 'combine',
        sources: [id('a')],
        decisions: [{ path: 'index.html', sources: [id('a')], status: 'clean' }],
        warnings: [] as string[],
        hints: [] as unknown[],
        blocked: [] as string[],
        compositionId: 'e'.repeat(64)
      }
    }
  };
  await page.evaluate(
    (r) => (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline(r),
    injected
  );
  const confirm = page.getByRole('button', { name: 'Confirm combined apply' });
  await expect(confirm).toBeEnabled();
  // Ticking another checkpoint changes the tray; the reviewed set no longer matches.
  await tick(page, id('b'));
  await expect(confirm).toBeDisabled();
});
