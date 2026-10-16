// Integration: pick an element on a real React dev bundle in a real browser,
// resolve its fiber creation site through the emitted source map, and extract
// the corresponding JSX element from the fixture source. Validates the whole
// framework element-picking chain end to end (React 18 _debugSource path).
import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { fiberSourceScript, type FiberPick } from '../../src/branches/fiber-source';
import { extractJsxElement } from '../../src/branches/framework';

const APP_TSX = `import React from 'react';

function Banner() {
  return <h2 className="banner">Hello</h2>;
}

export default function App() {
  return (
    <main>
      <Banner />
      <button id="cta" onClick={() => console.log('clicked')}>
        Buy now
      </button>
      <ul>
        <li>one</li>
      </ul>
    </main>
  );
}
`;

const ENTRY = `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(<App />);
`;

const INDEX_HTML = `<!DOCTYPE html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;

let server: Server;
let dir: string;
let appSource: string;
const PORT = 4703;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scrubline-fw-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'App.tsx'), APP_TSX);
  await writeFile(join(dir, 'src', 'entry.tsx'), ENTRY);
  await writeFile(join(dir, 'index.html'), INDEX_HTML);
  appSource = APP_TSX;
  await esbuild.build({
    absWorkingDir: dir,
    nodePaths: [join(process.cwd(), 'node_modules')],
    entryPoints: [join(dir, 'src', 'entry.tsx')],
    bundle: true,
    outfile: join(dir, 'bundle.js'),
    sourcemap: true,
    jsx: 'automatic',
    jsxDev: true,
    loader: { '.tsx': 'tsx' },
    logLevel: 'silent'
  });
  server = createServer(async (req, res) => {
    const path = req.url === '/' ? '/index.html' : (req.url ?? '/');
    try {
      const body = await readFile(join(dir, path));
      res.writeHead(200, {
        'content-type': path.endsWith('.js')
          ? 'text/javascript'
          : path.endsWith('.map')
            ? 'application/json'
            : 'text/html'
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test('fiber metadata is readable from a clicked React element in the browser', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('#cta');
  const handle = await page.$('#cta');
  const pick = await page.evaluate(
    ([el, src]) => {
      const fn = new Function(`return (${src})`)() as (e: Element) => FiberPick;
      return fn(el as Element);
    },
    [handle, fiberSourceScript.toString()] as const
  );
  expect(pick.tag).toBe('button');
  expect(pick.frames.length).toBeGreaterThan(0);
  // React <=18 (_debugSource): esbuild's jsxDev transform injects the
  // original file/line, so the frame already points at source, not bundle.
  expect(pick.frames[0].fileName).toContain('src/App.tsx');
  const expectedLine = appSource.split('\n').findIndex((l) => l.includes('<button')) + 1;
  expect(pick.frames[0].lineNumber).toBe(expectedLine);
  expect(pick.components).toContain('App');
});

test('creation frame extracts the exact JSX element from source', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('#cta');
  const handle = await page.$('#cta');
  const pick = await page.evaluate(
    ([el, src]) => {
      const fn = new Function(`return (${src})`)() as (e: Element) => FiberPick;
      return fn(el as Element);
    },
    [handle, fiberSourceScript.toString()] as const
  );
  // The extension's chain on this path: frame is already a tracked source
  // file, so extraction happens directly at the frame position.
  const element = extractJsxElement(
    appSource,
    pick.frames[0].lineNumber,
    pick.frames[0].columnNumber
  );
  expect(element).toBeDefined();
  expect(element!.componentName).toBe('App');
  expect(element!.tagName).toBe('button');
  // Skeleton covers the whole component tree: identity for correspondence.
  expect(element!.skeleton).toEqual(['main', 'banner', 'button', 'ul', 'li']);
});

test('component-created element resolves to its own component source', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('h2.banner');
  const handle = await page.$('h2.banner');
  const pick = await page.evaluate(
    ([el, src]) => {
      const fn = new Function(`return (${src})`)() as (e: Element) => FiberPick;
      return fn(el as Element);
    },
    [handle, fiberSourceScript.toString()] as const
  );
  expect(pick.tag).toBe('h2');
  expect(pick.components).toContain('Banner');
  const expectedLine = appSource.split('\n').findIndex((l) => l.includes('<h2')) + 1;
  expect(pick.frames[0].lineNumber).toBe(expectedLine);
  const element = extractJsxElement(
    appSource,
    pick.frames[0].lineNumber,
    pick.frames[0].columnNumber
  );
  expect(element).toBeDefined();
  expect(element!.componentName).toBe('Banner');
  expect(element!.tagName).toBe('h2');
  expect(element!.skeleton).toEqual(['h2']);
});
