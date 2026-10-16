import { test, expect } from 'vitest';
import { listPages, documentToRoute, routeToDocument, isPickableDocument } from '../../src/pages';
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
