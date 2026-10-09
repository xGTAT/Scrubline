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
for (const status of ['on', 'ready', 'stale', 'error'] as const) {
  test(`M3 ${status} concise accessible packet review`, async ({ page }) => {
    await page.setViewportSize({ width: 280, height: 740 });
    await page.goto('/');
    await expect(page.getByText('No checkpoints yet')).toBeVisible();
    await page.evaluate((status) => {
      (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline({
        status: 'ready',
        rows: [
          {
            id: 'a'.repeat(64),
            createdAt: '2026-10-05T15:00:00Z',
            changedPaths: ['index.html'],
            attribution: { kind: 'unattributed' }
          }
        ],
        unsaved: false,
        targeting: {
          status,
          packet:
            status === 'ready'
              ? 'Checkpoint: abc\nSelector: #save\nAccessible name: Save [email]\nDOM: <button>Save [redacted]</button>\nFiles: index.html'
              : undefined
        }
      });
    }, status);
    expect((await page.locator('body').innerText()).trim().split(/\s+/).length).toBeLessThanOrEqual(
      40
    );
    expect(
      (await new AxeBuilder({ page }).analyze()).violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical'
      )
    ).toEqual([]);
    if (status === 'ready') {
      await expect(page.getByRole('button', { name: 'Copy packet' })).toBeDisabled();
      await page.getByText('Review packet', { exact: true }).click();
      await expect(page.getByRole('button', { name: 'Copy packet' })).toBeEnabled();
      await expect(page.locator('pre')).toContainText('Save [redacted]');
      await page.getByText('Review packet', { exact: true }).click();
    } else await expect(page.getByRole('button', { name: 'Copy packet' })).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.screenshot({ path: `${evidenceDir}/panel_m3_${status}.png`, fullPage: true });
  });
}
test('M4 fork list and two alternatives comparison stay usable at narrow width', async ({
  page
}) => {
  await page.setViewportSize({ width: 280, height: 740 });
  await page.goto('/');
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  await page.evaluate(() => {
    const image =
      'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="140"%3E%3Crect width="200" height="140" fill="%23343a40"/%3E%3C/svg%3E';
    (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline({
      status: 'ready',
      unsaved: false,
      rows: [
        {
          id: 'a'.repeat(64),
          createdAt: '2026-10-05T15:00:00Z',
          changedPaths: ['navbar.html'],
          attribution: { kind: 'unattributed' }
        }
      ],
      branches: [
        {
          id: 'branch',
          name: 'Navbar',
          base: 'a',
          checkpoint: 'b'.repeat(64),
          directory: 'test-only'
        }
      ],
      comparison: { leftId: 'a', rightId: 'b', left: image, right: image }
    });
  });
  expect((await page.locator('body').innerText()).trim().split(/\s+/).length).toBeLessThanOrEqual(
    40
  );
  await page.getByText('Alternatives (1)').click();
  await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
  const bounds = await page.getByRole('button', { name: 'Choose files' }).boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(280);
  await expect(page.getByRole('button', { name: 'Navbar', exact: true })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).analyze()).violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical'
    )
  ).toEqual([]);
  await page.screenshot({ path: `${evidenceDir}/panel_m4_comparison.png`, fullPage: true });
});

for (const theme of ['dark', 'light', 'contrast'] as const) {
  test(`M6 ${theme} 1000 checkpoints responsive keyboard and motion`, async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 800 });
    await page.goto('/');
    await expect(page.getByText('No checkpoints yet')).toBeVisible();
    await page.evaluate((theme) => {
      if (theme === 'light')
        document.documentElement.style.cssText =
          '--vscode-foreground:#202020;--vscode-descriptionForeground:#565656;--vscode-sideBar-background:#f6f6f6;--vscode-editor-background:#ffffff;--vscode-widget-border:#c2c2c2;--vscode-list-inactiveSelectionBackground:#ededed;--vscode-button-secondaryBackground:#e4e4e4;--vscode-button-secondaryForeground:#222222';
      if (theme === 'contrast')
        document.documentElement.style.cssText =
          '--vscode-foreground:#ffffff;--vscode-descriptionForeground:#ffffff;--vscode-sideBar-background:#000000;--vscode-widget-border:#ffffff;--vscode-focusBorder:#ffff00;--vscode-button-background:#000000;--vscode-list-inactiveSelectionBackground:#000000';
      const w = window as unknown as { __sendTimeline: (v: unknown) => void };
      w.__sendTimeline({
        status: 'ready',
        rows: Array.from({ length: 1000 }, (_, i) => ({
          id: String(i),
          createdAt: '2026-10-05T15:00:00Z',
          changedPaths: ['index.html'],
          attribution: { kind: 'unattributed' }
        })),
        unsaved: false
      });
    }, theme);
    await expect(page.locator('.row')).toHaveCount(1);
    expect(await page.locator('main *').count()).toBeLessThan(65);
    await page.locator('#scrub').focus();
    await page.keyboard.press('End');
    await expect(page.locator('#scrub')).toHaveValue('999');
    await expect(page.getByRole('button', { name: 'Fork checkpoint' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    const violations = (await new AxeBuilder({ page }).analyze()).violations;
    expect(violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.locator('.panel').evaluate((e) => getComputedStyle(e).animationName)).toBe(
      'none'
    );
    await page.screenshot({ path: resolve(evidenceDir, `panel_m6_${theme}.png`), fullPage: true });
  });
}

test('M6 motion actual frames are stable and reduced-motion disables entry', async ({
  browser
}) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 740 },
    recordVideo: { dir: resolve(evidenceDir, 'motion'), size: { width: 360, height: 740 } }
  });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  await page.locator('.panel').evaluate((e) => {
    e.animate(
      [
        { opacity: 0.5, transform: 'translateY(3px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ],
      { duration: 180, fill: 'both' }
    ).pause();
  });
  await page.locator('.panel').evaluate((e) => {
    e.getAnimations().at(-1)!.currentTime = 0;
  });
  await page.screenshot({ path: resolve(evidenceDir, 'm6_motion_start.png') });
  await page.locator('.panel').evaluate((e) => {
    e.getAnimations().at(-1)!.currentTime = 90;
  });
  await page.screenshot({ path: resolve(evidenceDir, 'm6_motion_mid.png') });
  await page.locator('.panel').evaluate((e) => {
    e.getAnimations().at(-1)!.currentTime = 180;
  });
  await page.screenshot({ path: resolve(evidenceDir, 'm6_motion_end.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.panel').evaluate((e) => getComputedStyle(e).animationName)).toBe(
    'none'
  );
  await context.close();
});

test('v0.7 paged card slider changed paths and preview never disagree; render progress and playback', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __sendTimeline: (v: unknown) => void };
    w.__sendTimeline({
      status: 'ready',
      rows: [
        {
          id: 'a',
          createdAt: '2026-10-06T06:00:00Z',
          changedPaths: ['old-settings.json'],
          attribution: { kind: 'unattributed' }
        },
        {
          id: 'b',
          createdAt: '2026-10-06T06:01:00Z',
          changedPaths: ['headline.html'],
          attribution: { kind: 'unattributed' }
        }
      ],
      unsaved: false,
      selected: 'a',
      rendered: ['a', 'b'],
      preview: {
        status: 'ready',
        checkpoint: 'a',
        label: 'Cached screenshot',
        image:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW3sAAAAASUVORK5CYII='
      }
    });
  });
  await page.getByRole('button', { name: 'Newer', exact: true }).click();
  await expect(page.locator('#scrub')).toHaveValue('1');
  const selectedTime = await page.evaluate(() =>
    new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date('2026-10-06T06:01:00Z'))
  );
  await expect(page.locator('.row time')).toHaveText(selectedTime);
  await page.getByText('Changed paths (1)').click();
  await expect(page.getByRole('button', { name: 'headline.html' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'old-settings.json' })).toHaveCount(0);
  // Preview chrome stays visible while the next checkpoint is requested.
  await expect(page.getByText('Cached screenshot', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Older', exact: true }).click();
  await expect(page.locator('#scrub')).toHaveValue('0');
  await page.getByText('Render history (2/2)', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Render history', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.locator('#scrub')).toHaveValue('1', { timeout: 3000 });
  await page.screenshot({ path: resolve(evidenceDir, 'panel_v07_cache.png'), fullPage: true });
});

test('v0.7 render failures cancellation and late host selection stay explicit', async ({
  page
}) => {
  await page.goto('/');
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline({
      status: 'ready',
      rows: [
        {
          id: 'a',
          createdAt: '2026-10-06T06:00:00Z',
          changedPaths: ['one.html'],
          attribution: { kind: 'unattributed' }
        }
      ],
      unsaved: false,
      selected: 'a',
      rendering: { running: true, done: 0, total: 1, failed: 0 }
    });
  });
  await page.getByText('Render history (0/1)', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel render', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel render', exact: true }).click();
  await page.evaluate(() => {
    (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline({
      status: 'ready',
      rows: [
        {
          id: 'a',
          createdAt: '2026-10-06T06:00:00Z',
          changedPaths: ['one.html'],
          attribution: { kind: 'unattributed' }
        }
      ],
      unsaved: false,
      selected: 'a',
      rendering: {
        running: false,
        done: 0,
        total: 1,
        failed: 1,
        cancelled: true,
        message: 'Missing dependency'
      }
    });
  });
  await expect(page.getByText(/Missing dependency/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel render', exact: true })).toHaveCount(0);
});

test('v0.7.2 playback prerequisites explain zero renders and single checkpoint', async ({
  page
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  const rows = [
    {
      id: 'a',
      createdAt: '2026-10-07T06:00:00Z',
      changedPaths: [],
      attribution: { kind: 'unattributed' }
    },
    {
      id: 'b',
      createdAt: '2026-10-07T06:01:00Z',
      changedPaths: [],
      attribution: { kind: 'unattributed' }
    }
  ];
  await page.evaluate((rows) => {
    (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline({
      status: 'ready',
      rows,
      unsaved: false,
      selected: 'a',
      rendered: []
    });
  }, rows);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  await expect(page.getByText('Render history first.')).toBeVisible();
  await expect(page.locator('#scrub')).toBeEnabled();
  await page.screenshot({
    path: resolve(evidenceDir, 'panel_v072_no_renders.png'),
    fullPage: true
  });
  await page.evaluate((rows) => {
    (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline({
      status: 'ready',
      rows: rows.slice(0, 1),
      unsaved: false,
      selected: 'a',
      rendered: ['a']
    });
  }, rows);
  await expect(page.getByText('Save changes for another checkpoint.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  await expect(page.locator('#scrub')).toBeDisabled();
  await page.screenshot({
    path: resolve(evidenceDir, 'panel_v072_one_checkpoint.png'),
    fullPage: true
  });
  const issues = (await new AxeBuilder({ page }).analyze()).violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical'
  );
  expect(issues).toEqual([]);
});

test('v0.7.3 fullscreen retains decoded frames while seeking and animates changed regions', async ({
  page
}) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto('/');
  await expect(page.getByText('No checkpoints yet')).toBeVisible();
  const make = (text: string, fill: string) =>
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="${fill}"/><text x="80" y="100" fill="white" font-size="40">${text}</text></svg>`
    );
  const a = make('Before', '#142838'),
    b = make('After', '#203a46');
  await page.evaluate(
    ({ a }) => {
      (window as unknown as { __sendTimeline: (v: unknown) => void }).__sendTimeline({
        status: 'ready',
        rows: [
          {
            id: 'a',
            createdAt: '2026-10-08T06:00:00Z',
            changedPaths: [],
            attribution: { kind: 'unattributed' }
          },
          {
            id: 'b',
            createdAt: '2026-10-08T06:01:00Z',
            changedPaths: ['index.html'],
            attribution: { kind: 'unattributed' }
          }
        ],
        unsaved: false,
        selected: 'a',
        rendered: ['a', 'b'],
        preview: {
          status: 'ready',
          checkpoint: 'a',
          image: a,
          label: 'Cached screenshot',
          regions: [{ key: 'title', signature: 'before', x: 50, y: 50, width: 300, height: 70 }]
        }
      });
    },
    { a }
  );
  await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'a');
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect(page.locator('main')).toHaveClass(/fullscreen/);
  await expect(page.getByRole('slider')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'a');
  await expect(page.locator('.frame')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.frame-base')).toBeVisible();
  await page.evaluate(
    ({ b }) => {
      const w = window as unknown as { __sendTimeline: (v: unknown) => void };
      w.__sendTimeline({
        status: 'ready',
        rows: [
          {
            id: 'a',
            createdAt: '2026-10-08T06:00:00Z',
            changedPaths: [],
            attribution: { kind: 'unattributed' }
          },
          {
            id: 'b',
            createdAt: '2026-10-08T06:01:00Z',
            changedPaths: ['index.html'],
            attribution: { kind: 'unattributed' }
          }
        ],
        unsaved: false,
        selected: 'b',
        rendered: ['a', 'b'],
        preview: {
          status: 'ready',
          checkpoint: 'b',
          image: b,
          label: 'Cached screenshot',
          regions: [{ key: 'title', signature: 'after', x: 50, y: 60, width: 300, height: 70 }]
        }
      });
    },
    { b }
  );
  await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'b');
  await page.screenshot({
    path: resolve(evidenceDir, 'panel_v073_fullscreen.png'),
    fullPage: true
  });
  // A stale host acknowledgment must not drag the slider or replace the requested frame.
  await page.evaluate(
    ({ a }) => {
      const w = window as unknown as { __sendTimeline: (v: unknown) => void };
      w.__sendTimeline({
        status: 'ready',
        rows: [
          {
            id: 'a',
            createdAt: '2026-10-08T06:00:00Z',
            changedPaths: [],
            attribution: { kind: 'unattributed' }
          },
          {
            id: 'b',
            createdAt: '2026-10-08T06:01:00Z',
            changedPaths: ['index.html'],
            attribution: { kind: 'unattributed' }
          }
        ],
        unsaved: false,
        selected: 'a',
        rendered: ['a', 'b'],
        preview: { status: 'ready', checkpoint: 'a', image: a, label: 'Cached screenshot' }
      });
    },
    { a }
  );
  await expect(page.locator('#scrub')).toHaveValue('1');
  await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'b');
  await page.keyboard.press('Escape');
  await expect(page.locator('main')).not.toHaveClass(/fullscreen/);
});

for (const fullscreen of [false, true]) {
  test(`v0.7.6 preview chrome stays mounted during seek and playback (${fullscreen ? 'fullscreen' : 'sidebar'})`, async ({
    page
  }) => {
    await page.setViewportSize({ width: fullscreen ? 1000 : 320, height: 760 });
    await page.goto('/');
    await expect(page.getByText('No checkpoints yet')).toBeVisible();
    await page.evaluate(() => {
      const image =
        'data:image/svg+xml,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="#203a46"/></svg>'
        );
      const rows = ['a', 'b', 'c'].map((id, i) => ({
        id,
        createdAt: `2026-10-09T06:0${i}:00Z`,
        changedPaths: ['index.html'],
        attribution: { kind: 'unattributed' }
      }));
      const w = window as unknown as {
        __sendTimeline: (v: unknown) => void;
        __seek: (id: string, loading?: boolean) => void;
      };
      w.__seek = (id, loading = false) =>
        w.__sendTimeline({
          status: 'ready',
          rows,
          selected: id,
          unsaved: false,
          rendered: ['a', 'b', 'c'],
          preview: loading
            ? { status: 'loading' }
            : { status: 'ready', checkpoint: id, image, label: 'Cached screenshot' }
        });
      w.__seek('a');
    });
    await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'a');
    if (fullscreen) await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    const before = await page.locator('.preview').boundingBox();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Cached screenshot', { exact: true })).toBeVisible();
    await expect(page.locator('.preview small').filter({ hasText: 'Selected' })).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { __seek: (id: string, loading?: boolean) => void }).__seek('b', true)
    );
    await expect(page.getByText('Cached screenshot', { exact: true })).toBeVisible();
    expect((await page.locator('.preview').boundingBox())!.height).toBeCloseTo(before!.height, 2);
    await page.evaluate(() => (window as unknown as { __seek: (id: string) => void }).__seek('b'));
    await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'b');
    await page.getByRole('button', { name: 'Prev', exact: true }).click();
    await expect(page.getByText('Cached screenshot', { exact: true })).toBeVisible();
    await page.evaluate(() => (window as unknown as { __seek: (id: string) => void }).__seek('a'));
    await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'a');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.getByRole('slider')).toHaveValue('1');
    await expect(page.getByText('Cached screenshot', { exact: true })).toBeVisible();
    expect((await page.locator('.preview').boundingBox())!.height).toBeCloseTo(before!.height, 2);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.screenshot({
      path: `/downloads/scrubline-v076-${fullscreen ? 'fullscreen' : 'sidebar'}.png`,
      fullPage: true
    });
  });
}

for (const fullscreen of [false, true]) {
  test(`v0.7.8 fades at every scrub speed (${fullscreen})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('No checkpoints yet')).toBeVisible();
    await page.evaluate(() => {
      const rows = ['a', 'b', 'c'].map((id, i) => ({
        id,
        createdAt: `2026-10-09T06:0${i}:00Z`,
        changedPaths: [],
        attribution: { kind: 'unattributed' }
      }));
      const w = window as unknown as {
        __sendTimeline: (v: unknown) => void;
        __frame: (id: string) => void;
      };
      w.__frame = (id) =>
        w.__sendTimeline({
          status: 'ready',
          rows,
          selected: id,
          unsaved: false,
          rendered: ['a', 'b', 'c'],
          preview: {
            status: 'ready',
            checkpoint: id,
            label: 'Cached screenshot',
            image:
              'data:image/svg+xml,' +
              encodeURIComponent(
                `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="${id === 'a' ? '#142838' : id === 'b' ? '#203a46' : '#483028'}"/></svg>`
              ),
            regions: [{ key: 'title', signature: id, x: 50, y: 50, width: 300, height: 70 }]
          }
        });
      w.__frame('a');
    });
    await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'a');
    if (fullscreen) await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
    const slider = page.getByRole('slider');
    const input = async (value: string) =>
      slider.evaluate((el: HTMLInputElement, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
    const frame = async (id: string) =>
      page.evaluate(
        (id) => (window as unknown as { __frame: (id: string) => void }).__frame(id),
        id
      );
    await slider.dispatchEvent('pointerdown');
    await input('1');
    await frame('b');
    await expect(page.locator('.frame-out')).toBeVisible();
    await expect(page.locator('.region-in')).toBeVisible();
    await page.waitForTimeout(250);
    await input('0');
    await frame('a');
    await expect(page.locator('.frame-out')).toBeVisible();
    // Continuous inputs must still animate, starting from the composited pixels.
    await input('0.7');
    await input('1.5');
    await frame('c');
    await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'c');
    await expect(page.locator('.frame-out')).toBeVisible();
    await expect(page.locator('.region-in')).toBeVisible();
    expect(await page.locator('.frame-out').getAttribute('src')).toContain('data:image/png');
    await slider.dispatchEvent('pointerup');
    await expect(page.locator('.frame-out')).toBeVisible();
    await expect(page.locator('.region-in')).toBeVisible();
    await expect(slider).toHaveValue('2');
    await page.screenshot({
      path: `/downloads/scrubline-v078-${fullscreen ? 'fullscreen' : 'sidebar'}.png`
    });
    await expect(page.locator('.frame-out')).toHaveCount(0);
    // A frame arriving after release must still animate, not be dropped.
    await slider.dispatchEvent('pointerdown');
    await input('1');
    await input('0');
    await slider.dispatchEvent('pointerup');
    await frame('a');
    await expect(page.locator('.frame')).toHaveAttribute('data-checkpoint', 'a');
    await expect(page.locator('.frame-out')).toBeVisible();
  });
}
