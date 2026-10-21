import { test, expect } from 'vitest';
import {
  listPages,
  documentToRoute,
  routeToDocument,
  isPickableDocument,
  pageFiles,
  rowRelevantToPage
} from '../../src/pages';
import { mainlineBase } from '../../src/branches/alternatives';
import type { Checkpoint } from '../../src/bridge/timeline';
import { specification } from '../../src/preview/spec';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const base = { command: 'node server', port: 4100, timeoutMs: 5000 };

async function fixture(files: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-pages-'));
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), '<!doctype html><title>t</title>');
  }
  return root;
}

test('route and document mapping round-trips like the preview server', () => {
  expect(documentToRoute('index.html')).toBe('/');
  expect(documentToRoute('about.html')).toBe('/about.html');
  expect(documentToRoute('docs/guide.html')).toBe('/docs/guide.html');
  expect(routeToDocument('/')).toBe('index.html');
  expect(routeToDocument('/about.html')).toBe('about.html');
  expect(routeToDocument('/docs/guide.html')).toBe('docs/guide.html');
});

test('listPages finds nested pages, root index first, skips dependency and hidden folders', async () => {
  const root = await fixture([
    'index.html',
    'about.html',
    'docs/guide.html',
    'node_modules/pkg/index.html',
    '.git/hooks/sample.html',
    'dist/bundle.html',
    'src/app.ts'
  ]);
  try {
    const pages = await listPages(root);
    expect(pages.map((p) => p.route)).toEqual(['/', '/about.html', '/docs/guide.html']);
    expect(pages.map((p) => p.document)).toEqual(['index.html', 'about.html', 'docs/guide.html']);
    for (const page of pages) expect(specification({ ...base, route: page.route })).toBeTruthy();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('listPages returns an empty list when the workspace has no HTML pages', async () => {
  const root = await fixture(['readme.md', 'src/main.ts']);
  try {
    expect(await listPages(root)).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('isPickableDocument requires a tracked static HTML document', () => {
  const files = [{ path: 'index.html' }, { path: 'about.html' }, { path: 'app.js' }];
  expect(isPickableDocument('index.html', files)).toBe(true);
  expect(isPickableDocument('about.html', files)).toBe(true);
  expect(isPickableDocument('dashboard', files)).toBe(false);
  expect(isPickableDocument('missing.html', files)).toBe(false);
  expect(isPickableDocument('app.js', files)).toBe(false);
  expect(isPickableDocument('index.html', [])).toBe(false);
});

test('mainlineBase resolves the parent for timeline checkpoints only', () => {
  const cp = (id: string, parentId?: string, branch?: { id: string; name: string }): Checkpoint =>
    ({
      id,
      parentId,
      branch,
      schemaVersion: 1,
      createdAt: '2026-10-16T00:00:00Z',
      trigger: 'save',
      files: [],
      attribution: { kind: 'unattributed' }
    }) as Checkpoint;
  const root = cp('a'.repeat(64));
  const child = cp('b'.repeat(64), root.id);
  const branchCp = cp('c'.repeat(64), root.id, { id: 'br1', name: 'Alt' });
  const checkpoints = [root, child, branchCp];
  expect(mainlineBase(child, checkpoints)?.id).toBe(root.id);
  expect(mainlineBase(root, checkpoints)).toBeUndefined();
  expect(mainlineBase(branchCp, checkpoints)).toBeUndefined();
  expect(mainlineBase(cp('d'.repeat(64), 'f'.repeat(64)), checkpoints)).toBeUndefined();
});

test('pageFiles maps a page to its document and local asset graph', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-pagemap-'));
  try {
    await fs.mkdir(path.join(root, 'css'), { recursive: true });
    await fs.mkdir(path.join(root, 'js'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'index.html'),
      `<!doctype html><link rel="stylesheet" href="css/index.css?v=2"><script src="js/app.js"></script><img src="logo.png"><script src="https://cdn.example.com/lib.js"></script>`
    );
    await fs.writeFile(
      path.join(root, 'css/index.css'),
      `@import 'shared.css'; .a { background: url('../logo.png#icon'); }`
    );
    await fs.writeFile(
      path.join(root, 'css/shared.css'),
      `.b { background: url('data:image/png;base64,x'); }`
    );
    await fs.writeFile(path.join(root, 'js/app.js'), 'console.log(1)');
    await fs.writeFile(path.join(root, 'logo.png'), 'png');
    const files = await pageFiles(root, 'index.html');
    expect([...files].sort()).toEqual([
      'css/index.css',
      'css/shared.css',
      'index.html',
      'js/app.js',
      'logo.png'
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('pageFiles keeps missing referenced files and resolves root-absolute references', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-pagemap-'));
  try {
    await fs.writeFile(
      path.join(root, 'booking.html'),
      `<!doctype html><link rel="stylesheet" href="/css/booking.css"><img srcset="a.png 1x, b.png 2x">`
    );
    const files = await pageFiles(root, 'booking.html');
    expect([...files].sort()).toEqual(['a.png', 'b.png', 'booking.html', 'css/booking.css']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('checkpoints surface only on the pages they change', async () => {
  // Shravan's report: editing index.html must not create a visible checkpoint
  // on booking.html, and vice versa.
  const index = new Set(['index.html', 'css/index.css', 'css/shared.css', 'logo.png']);
  const booking = new Set(['booking.html', 'css/booking.css', 'css/shared.css', 'logo.png']);
  const all = new Set([...index, ...booking]);

  // A change to index.html only shows on the index page.
  expect(rowRelevantToPage(['index.html'], index, all)).toBe(true);
  expect(rowRelevantToPage(['index.html'], booking, all)).toBe(false);
  // A change to booking's own stylesheet only shows on booking.
  expect(rowRelevantToPage(['css/booking.css'], index, all)).toBe(false);
  expect(rowRelevantToPage(['css/booking.css'], booking, all)).toBe(true);
  // Shared assets show on both pages.
  expect(rowRelevantToPage(['css/shared.css', 'logo.png'], index, all)).toBe(true);
  expect(rowRelevantToPage(['css/shared.css', 'logo.png'], booking, all)).toBe(true);
  // Files no page maps (config, framework sources) stay visible everywhere.
  expect(rowRelevantToPage(['vite.config.ts', 'src/App.tsx'], index, all)).toBe(true);
  expect(rowRelevantToPage(['vite.config.ts', 'src/App.tsx'], booking, all)).toBe(true);
  // A server route with no static document keeps every row.
  expect(rowRelevantToPage(['index.html'], new Set(), all)).toBe(true);
  // The baseline checkpoint (everything changed) shows everywhere.
  expect(rowRelevantToPage([...all], index, all)).toBe(true);
  expect(rowRelevantToPage([...all], booking, all)).toBe(true);
});

test('navigation links between pages are not page dependencies (web-lab regression)', async () => {
  // Every web-lab page links to every other page in its nav. Those <a href>
  // references must not merge pages: editing index.html must stay off
  // booking.html even though booking.html links to it.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-pagenav-'));
  try {
    await fs.writeFile(
      path.join(root, 'index.html'),
      `<!doctype html><link rel="stylesheet" href="site.css"><nav><a href="booking.html">Book</a><a href="dashboard.html">Dash</a></nav>`
    );
    await fs.writeFile(
      path.join(root, 'booking.html'),
      `<!doctype html><link rel="stylesheet" href="site.css"><script src="booking.js"></script><a href="index.html">Home</a>`
    );
    await fs.writeFile(
      path.join(root, 'dashboard.html'),
      `<!doctype html><link rel="stylesheet" href="site.css"><script src="dashboard.js"></script><a href="index.html">Home</a>`
    );
    await fs.writeFile(path.join(root, 'site.css'), 'body{}');
    await fs.writeFile(path.join(root, 'booking.js'), '');
    await fs.writeFile(path.join(root, 'dashboard.js'), '');
    const index = await pageFiles(root, 'index.html');
    const booking = await pageFiles(root, 'booking.html');
    const all = new Set([...index, ...booking]);
    expect([...index].sort()).toEqual(['index.html', 'site.css']);
    expect([...booking].sort()).toEqual(['booking.html', 'booking.js', 'site.css']);
    expect(rowRelevantToPage(['index.html'], booking, all)).toBe(false);
    expect(rowRelevantToPage(['booking.js'], index, all)).toBe(false);
    expect(rowRelevantToPage(['site.css'], index, all)).toBe(true);
    expect(rowRelevantToPage(['site.css'], booking, all)).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
}

test('listPages surfaces React component modules on the app route', async () => {
  const root = await fixture(['index.html']);
  await writeFiles(root, {
    'src/App.tsx': 'export function App() { return null; }',
    'src/components/Card.tsx': 'export function Card() { return null; }',
    'src/App.test.tsx': 'test', // tests are not pages
    'src/types.d.ts': 'export {}', // declarations are not pages
    'src/__tests__/App.spec.tsx': 'test'
  });
  try {
    const pages = await listPages(root);
    expect(pages).toEqual([
      { route: '/', document: 'index.html' },
      { route: '/', document: 'src/App.tsx' },
      { route: '/', document: 'src/components/Card.tsx' }
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('listPages maps file-based framework routes', async () => {
  const root = await fixture([]);
  await writeFiles(root, {
    'pages/index.tsx': 'export default function Home() {}',
    'pages/about.tsx': 'export default function About() {}',
    'pages/api/health.ts': 'export default function handler() {}', // api routes are not pages
    'pages/_app.tsx': 'export default function App() {}', // next internals are not pages
    'src/pages/index.astro': '<html></html>',
    'src/pages/docs/guide.md': '# guide',
    'app/dashboard/page.tsx': 'export default function Dashboard() {}',
    'src/routes/settings/+page.svelte': '<h1>settings</h1>',
    'app/routes/_index.tsx': 'export default function Index() {}',
    'app/routes/tickets.$id.tsx': 'export default function Ticket() {}'
  });
  try {
    const routes = new Map((await listPages(root)).map((p) => [p.document, p.route]));
    expect(routes.get('pages/index.tsx')).toBe('/');
    expect(routes.get('pages/about.tsx')).toBe('/about');
    expect(routes.has('pages/api/health.ts')).toBe(false);
    expect(routes.has('pages/_app.tsx')).toBe(false);
    expect(routes.get('src/pages/index.astro')).toBe('/');
    expect(routes.get('src/pages/docs/guide.md')).toBe('/docs/guide');
    expect(routes.get('app/dashboard/page.tsx')).toBe('/dashboard');
    expect(routes.get('src/routes/settings/+page.svelte')).toBe('/settings');
    expect(routes.get('app/routes/_index.tsx')).toBe('/');
    expect(routes.get('app/routes/tickets.$id.tsx')).toBe('/tickets/:id');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('listPages keeps the html page when a framework route collides', async () => {
  const root = await fixture(['index.html']);
  await writeFiles(root, {
    'pages/index.tsx': 'export default function Home() {}'
  });
  try {
    const pages = await listPages(root);
    expect(pages.filter((p) => p.route === '/')).toEqual([{ route: '/', document: 'index.html' }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('pageFiles follows local module imports, aliases and style imports', async () => {
  const root = await fixture(['index.html']);
  await writeFiles(root, {
    'index.html': '<script type="module" src="/src/main.tsx"></script>',
    'src/main.tsx': 'import { App } from "./App";\nimport "./styles/app.css";',
    'src/App.tsx': 'import { Card } from "@/components/Card";\nimport React from "react";',
    'src/components/Card.tsx': 'import { util } from "../lib/util";',
    'src/lib/util.ts': 'export const util = 1;',
    'src/styles/app.css': '@import "./reset.css";',
    'src/styles/reset.css': 'html {}'
  });
  try {
    const files = await pageFiles(root, 'index.html');
    expect(files).toEqual(
      new Set([
        'index.html',
        'src/main.tsx',
        'src/App.tsx',
        'src/components/Card.tsx',
        'src/lib/util.ts',
        'src/styles/app.css',
        'src/styles/reset.css'
      ])
    );
    // A checkpoint on a transitive dependency belongs on the page.
    expect(rowRelevantToPage(['src/lib/util.ts'], files, files)).toBe(true);
    // Bare package imports are never workspace files.
    expect([...files].some((f) => f.includes('react'))).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('pageFiles scopes a component module page to its own import closure', async () => {
  const root = await fixture([]);
  await writeFiles(root, {
    'src/App.tsx': 'import { Card } from "./components/Card";',
    'src/components/Card.tsx': 'import { util } from "../lib/util";',
    'src/lib/util.ts': 'export const util = 1;',
    'src/unrelated.ts': 'export const other = 1;'
  });
  try {
    const appFiles = await pageFiles(root, 'src/App.tsx');
    const cardFiles = await pageFiles(root, 'src/components/Card.tsx');
    const all = new Set([...appFiles, ...cardFiles]);
    // Editing the Card shows on both pages; editing an unrelated file on neither
    // page proves it belongs elsewhere only when some page maps it.
    expect(rowRelevantToPage(['src/components/Card.tsx'], appFiles, all)).toBe(true);
    expect(rowRelevantToPage(['src/unrelated.ts'], cardFiles, all)).toBe(true); // unmapped stays visible
    expect(appFiles.has('src/unrelated.ts')).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
