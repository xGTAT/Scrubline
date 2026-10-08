import { test, expect, afterEach } from 'vitest';
import { chromium } from 'playwright-core';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { redact, envValues } from '../../src/targeting/redact';
import { makePacket } from '../../src/targeting/packet';
import { installOverlay } from '../../src/targeting/overlay';
import { HistoryStore } from '../../src/store/store';
import { scan } from '../../src/capture/scanner';
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
test('redacts seeded secrets, email, tokens, local urls and absolute paths', () => {
  const values = envValues(
    'API_KEY="custom-env-value"\nPASSWORD=another-private-value\n# ignored\nPORT=4100'
  );
  const result = redact(
    'custom-env-value another-private-value person@example.com sk-abcdefghijkl123 C:\\Users\\Shravan\\secret /home/shravan/app /tmp/run Bearer abc123 TOKEN=plain-secret http://127.0.0.1:4100',
    values
  );
  for (const s of [
    'custom-env-value',
    'another-private-value',
    'person@example.com',
    'sk-abcdefghijkl123',
    'C:\\Users',
    '/home/shravan',
    '/tmp/run',
    'abc123',
    'plain-secret',
    '127.0.0.1'
  ])
    expect(result).not.toContain(s);
});
test('packet accuracy matches checkpoint, paths, DOM and deterministic summary', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-packet-'));
  dirs.push(temp);
  const root = path.join(temp, 'project');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'button.html'), '<button>Save</button>');
  const store = new HistoryStore(path.join(temp, 'store'));
  await store.open();
  const s = await scan(root, store.root);
  const cp = await store.commit(s.files, s.contents, 'baseline', { kind: 'unattributed' });
  const selection = {
    selector: '#save',
    tag: 'button',
    name: 'Save person@example.com',
    snippet: '<button>Save person@example.com</button>',
    route: '/dashboard?token=secret',
    fingerprint: 'fingerprint'
  };
  const packet = makePacket(cp, undefined, selection);
  expect(packet.checkpoint).toBe(cp.id);
  expect(packet.selector).toBe('#save');
  expect(packet.route).toBe('/dashboard');
  expect(packet.name).toBe('Save [email]');
  expect(packet.body).toContain('- button.html');
  expect(packet.summary).toContain('1 file changed');
  expect(packet.body).not.toContain('token=secret');
  expect(packet.body).not.toContain('reasoning');
});
test('overlay selects correct button; stale replacement is rejected, never retargeted', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage();
    let selection: unknown;
    await page.exposeFunction('__scrublineSelect', (value) => {
      selection = value;
    });
    await page.setContent(
      '<button id="save" aria-label="Save draft">Save</button><button id="cancel">Cancel</button>'
    );
    await page.evaluate(installOverlay);
    await page.getByRole('button', { name: 'Save draft' }).click();
    expect(selection).toMatchObject({
      selector: '#save',
      tag: 'button',
      name: 'Save draft',
      snippet: '<button>Save</button>'
    });
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { __scrublineTarget: { validate: () => boolean } }
        ).__scrublineTarget.validate()
      )
    ).toBe(true);
    await page.evaluate(() => {
      document.getElementById('save')!.remove();
      document.body.insertAdjacentHTML(
        'beforeend',
        '<button id="save" aria-label="Delete draft">Delete</button>'
      );
    });
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { __scrublineTarget: { validate: () => boolean } }
        ).__scrublineTarget.validate()
      )
    ).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('#scrubline-target-indicator').count()).resolves.toBe(0);
  } finally {
    await browser.close();
  }
});
test('reload-compatible selector identifies same semantic element; duplicates refused', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><button data-testid="go">Go</button></main>');
    await page.evaluate(installOverlay);
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    const selected = await page.evaluate(
      () =>
        (window as unknown as { __scrublineTarget: { selected: { selector: string } } })
          .__scrublineTarget.selected
    );
    await page.setContent('<main><button data-testid="go">Go</button></main>');
    expect(await page.locator(selected.selector).innerText()).toBe('Go');
    await page.evaluate(installOverlay);
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await page.evaluate(() =>
      document.body.insertAdjacentHTML('beforeend', '<button data-testid="go">Go</button>')
    );
    expect(
      await page.evaluate(() =>
        (
          window as unknown as { __scrublineTarget: { validate: () => boolean } }
        ).__scrublineTarget.validate()
      )
    ).toBe(false);
  } finally {
    await browser.close();
  }
});
test('targeting session captures redacted crop, validates reload, editing yields checkpoint', async () => {
  const { createServer } = await import('node:http');
  let content =
    '<button id="save" aria-label="Save draft">Save person@example.com custom-secret</button>';
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(content);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-target-session-'));
  dirs.push(temp);
  const { TargetSession } = await import('../../src/targeting/session');
  let selection: import('../../src/targeting/packet').Selection | undefined;
  let crop: string | undefined;
  const session = new TargetSession(
    chromium.executablePath(),
    temp,
    (s, c) => {
      selection = s;
      crop = c;
    },
    () => {}
  );
  try {
    await session.start(`http://127.0.0.1:${port}`, ['custom-secret'], true);
    const page = (session as unknown as { page: import('playwright-core').Page }).page;
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect.poll(() => selection, { timeout: 5000 }).toBeDefined();
    await expect.poll(() => crop, { timeout: 5000 }).toBeDefined();
    expect(await session.validate()).toBe(true);
    await page.evaluate(() => {
      document.querySelector('#save')!.textContent = 'Save';
    });
    await page.screenshot({ path: path.resolve('../../docs/evidence/m3_selected_highlight.png') });
    await page.reload();
    expect(await session.validate()).toBe(true);
    content = '<button id="save" aria-label="Delete draft">Delete</button>';
    await page.reload();
    expect(await session.validate()).toBe(false);
    const root = path.join(temp, 'project');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'index.html'), '<button>Save</button>');
    const store = new HistoryStore(path.join(temp, 'history'));
    await store.open();
    let s = await scan(root, store.root);
    const before = await store.commit(s.files, s.contents, 'baseline', { kind: 'unattributed' });
    await fs.writeFile(path.join(root, 'index.html'), content);
    s = await scan(root, store.root);
    const after = await store.commit(s.files, s.contents, 'watcher', { kind: 'unattributed' });
    expect(after.id).not.toBe(before.id);
    const packet = makePacket(after, before, selection!, ['custom-secret']);
    expect(packet.body).not.toContain('custom-secret');
    expect(packet.body).not.toContain('person@example.com');
    await fs.mkdir(path.resolve('../../docs/evidence'), { recursive: true });
    await fs.copyFile(crop!, path.resolve('../../docs/evidence/m3_redacted_target_crop.png'));
    await page.screenshot({
      path: path.resolve('../../docs/evidence/m3_stale_target_preview.png')
    });
  } finally {
    await session.stop();
    await new Promise<void>((r) => server.close(() => r()));
  }
}, 15000);

test('sanitized crop preserves inherited dark background and white heading contrast', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<body style="background:#0f172a;color:#fff"><h1 id="title">Visible heading</h1></body>'
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-crop-contrast-'));
  dirs.push(temp);
  const { TargetSession } = await import('../../src/targeting/session');
  let crop: string | undefined;
  const session = new TargetSession(
    chromium.executablePath(),
    temp,
    (_s, c) => {
      crop = c;
    },
    () => {}
  );
  try {
    await session.start(`http://127.0.0.1:${port}`, [], true);
    const page = (session as unknown as { page: import('playwright-core').Page }).page;
    await page.locator('#title').click();
    await expect.poll(() => crop, { timeout: 5000 }).toBeDefined();
    const data = (await fs.readFile(crop!)).toString('base64');
    const pixels = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      return {
        background: [...rgba.slice(0, 3)],
        white: rgba.some((v, i) => i % 4 === 0 && v === 255)
      };
    }, data);
    expect(pixels.background).toEqual([15, 23, 42]);
    expect(pixels.white).toBe(true);
  } finally {
    await session.stop();
    await new Promise<void>((r) => server.close(() => r()));
  }
}, 15000);
