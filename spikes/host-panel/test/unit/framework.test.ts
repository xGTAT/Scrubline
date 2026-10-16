import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HistoryStore } from '../../src/store/store';
import { scan } from '../../src/capture/scanner';
import { frameworkElementCandidate } from '../../src/framework/candidate';
import { elementCandidate } from '../../src/branches/element';
import { detectFrameworks } from '../../src/framework/detect';
import { indexJsx } from '../../src/framework/jsx';
import { indexSfc } from '../../src/framework/sfc';

const LAB = path.join(__dirname, '..', '..', '..', '..', 'fixtures', 'framework-lab');

async function setup(fixture: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-fw-'));
  const work = path.join(root, 'project');
  await fs.cp(path.join(LAB, fixture), work, { recursive: true });
  const store = new HistoryStore(path.join(root, 'history'));
  await store.open();
  const capture = async () => {
    const s = await scan(work, store.root);
    return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
  };
  const edit = async (rel: string, from: string | RegExp, to: string) => {
    const p = path.join(work, rel);
    const text = await fs.readFile(p, 'utf8');
    const next = text.replace(from, to);
    if (next === text) throw new Error(`edit did not apply: ${rel}`);
    await fs.writeFile(p, next);
  };
  const blob = async (cp: Awaited<ReturnType<typeof capture>>, p: string) =>
    (await store.readBlob(cp.files.find((f) => f.path === p)!.hash)).toString();
  return { root, work, store, capture, edit, blob };
}

test('react TSX: picked nav restores markup and paired SCSS, unrelated edits stay current', async () => {
  const { root, store, capture, edit, blob } = await setup('react-tsx');
  try {
    const old = await capture();
    await edit('src/App.tsx', '<a href="/">Home</a>', '<a href="/">Homepage</a>');
    await edit(
      'src/App.tsx',
      '<p className="tagline">Old tagline</p>',
      '<p className="tagline">New tagline</p>'
    );
    await edit('src/styles/app.scss', 'color: red;', 'color: blue;');
    const now = await capture();
    const { candidate } = await frameworkElementCandidate(store, old, now, { id: 'top-nav' });
    const tsx = await blob(candidate, 'src/App.tsx');
    const scss = await blob(candidate, 'src/styles/app.scss');
    expect(tsx).toContain('<a href="/">Home</a>');
    expect(tsx).toContain('<p className="tagline">New tagline</p>'); // outside nav: stays current
    expect(scss).toContain('color: red'); // owned #top-nav rule rolled back
    expect(scss).toContain('background: white'); // unrelated rule stays current
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('react TSX: text pick on a unique heading resolves via data-testid path and inline styles travel', async () => {
  const { root, store, capture, edit, blob } = await setup('react-tsx');
  try {
    const old = await capture();
    await edit('src/App.tsx', 'style={{ padding: 8 }}', 'style={{ padding: 24 }}');
    await edit('src/App.tsx', 'Hello world', 'Hello there');
    const now = await capture();
    const { candidate } = await frameworkElementCandidate(store, old, now, { testId: 'title' });
    const tsx = await blob(candidate, 'src/App.tsx');
    expect(tsx).toContain('Hello world');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('react TSX: element inside a component file resolves across files', async () => {
  const { root, store, capture, edit, blob } = await setup('react-tsx');
  try {
    const old = await capture();
    await edit('src/components/Card.tsx', '>Open<', '>Launch<');
    const now = await capture();
    const { candidate } = await frameworkElementCandidate(store, old, now, {
      testId: 'card-title'
    });
    const card = await blob(candidate, 'src/components/Card.tsx');
    // h2 restore only; the button below it stays current
    expect(card).toContain('>Launch<');
    const { candidate: btnCandidate } = await frameworkElementCandidate(store, old, now, {
      tag: 'button',
      text: 'Open'
    });
    const card2 = await blob(btnCandidate, 'src/components/Card.tsx');
    expect(card2).toContain('>Open<');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('react TSX: ambiguous repeated elements without anchors are refused', async () => {
  const { root, store, capture, edit } = await setup('react-tsx');
  try {
    const old = await capture();
    await edit('src/components/Card.tsx', '<li className="card">', '<li className="card wide">');
    const now = await capture();
    await expect(frameworkElementCandidate(store, old, now, { tag: 'a' })).rejects.toThrow(
      'Cannot map'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('css-in-js: markup restores, component styles stay current with a note', async () => {
  const { root, store, capture, edit, blob } = await setup('css-in-js');
  try {
    const old = await capture();
    await edit('src/Widget.tsx', 'color: red;', 'color: green;');
    await edit('src/Widget.tsx', 'Old widget', 'New widget');
    const now = await capture();
    const { candidate, notes } = await frameworkElementCandidate(store, old, now, {
      testId: 'widget-title'
    });
    const tsx = await blob(candidate, 'src/Widget.tsx');
    expect(tsx).toContain('Old widget');
    expect(tsx).toContain('color: green;'); // styled-components rule NOT rolled back
    expect(notes.some((n) => n.includes('CSS-in-JS'))).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('vue SFC: template element restores and scoped style block pairs', async () => {
  const { root, store, capture, edit, blob } = await setup('vue-sfc');
  try {
    const old = await capture();
    await edit(
      'src/App.vue',
      '<p class="tagline">Old tagline</p>',
      '<p class="tagline">New tagline</p>'
    );
    await edit('src/App.vue', 'color: gray;', 'color: purple;');
    const now = await capture();
    const { candidate } = await frameworkElementCandidate(store, old, now, { testId: 'title' });
    const vue = await blob(candidate, 'src/App.vue');
    // h1 itself unchanged; this pick targets the h1 - no text delta on it.
    // The scoped .tagline rule is outside the h1 subtree and must stay current.
    expect(vue).toContain('color: purple;');
    const { candidate: section } = await frameworkElementCandidate(store, old, now, {
      tag: 'section',
      text: 'Bonjour Old tagline'
    });
    const vue2 = await blob(section, 'src/App.vue');
    expect(vue2).toContain('<p class="tagline">Old tagline</p>');
    expect(vue2).toContain('color: gray;'); // owned scoped rule rolled back with section
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('svelte: each-block markup parses, element and style block restore', async () => {
  const { root, store, capture, edit, blob } = await setup('svelte');
  try {
    const old = await capture();
    await edit(
      'src/App.svelte',
      '<p class="tagline">Old tagline</p>',
      '<p class="tagline">New tagline</p>'
    );
    await edit('src/App.svelte', 'color: gray;', 'color: teal;');
    const now = await capture();
    const { candidate } = await frameworkElementCandidate(store, old, now, {
      tag: 'section',
      text: 'Hej Old tagline'
    });
    const svelte = await blob(candidate, 'src/App.svelte');
    expect(svelte).toContain('<p class="tagline">Old tagline</p>');
    expect(svelte).toContain('color: gray;');
    expect(svelte).toContain('{#each items as it}'); // masked syntax restored intact
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('astro: frontmatter preserved and template element restores', async () => {
  const { root, store, capture, edit, blob } = await setup('astro');
  try {
    const old = await capture();
    await edit(
      'src/pages/index.astro',
      '<p class="tagline">Old tagline</p>',
      '<p class="tagline">New tagline</p>'
    );
    const now = await capture();
    const { candidate } = await frameworkElementCandidate(store, old, now, {
      tag: 'section',
      text: 'Old tagline'
    });
    const astro = await blob(candidate, 'src/pages/index.astro');
    expect(astro).toContain("const title = 'Namaste';");
    expect(astro).toContain('<p class="tagline">Old tagline</p>');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('angular template: existing HTML path accepts *ngFor, [binding] and (click)', async () => {
  const { root, store, capture, edit, blob } = await setup('angular');
  try {
    const old = await capture();
    await edit('src/app/app.component.html', '>Go</button>', '>Run</button>');
    const now = await capture();
    const target = await elementCandidate(store, old, now, 'src/app/app.component.html', 'top-nav');
    const html = await blob(target, 'src/app/app.component.html');
    expect(html).toContain('*ngFor="let l of links"');
    expect(html).toContain('(click)="go()"');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('structural drift between versions refuses instead of guessing', async () => {
  const { root, store, capture, edit } = await setup('react-tsx');
  try {
    const old = await capture();
    await edit('src/App.tsx', '<section className="hero"', '<div><section className="hero"');
    await edit('src/App.tsx', '</section>', '</section></div>');
    const now = await capture();
    await expect(
      frameworkElementCandidate(store, old, now, { tag: 'h1', text: 'Hello world' })
    ).rejects.toThrow('Cannot map');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('detection reports languages and frameworks from a fixture checkpoint', async () => {
  const { root, store, capture } = await setup('react-tsx');
  try {
    const cp = await capture();
    const report = await detectFrameworks(cp, (h) => store.readBlob(h));
    expect(report.frameworks).toContain('React');
    expect(report.frameworks).toContain('Vite');
    expect(report.frameworks).toContain('Tailwind CSS');
    expect(report.languages).toContain('TypeScript');
    expect(report.languages).toContain('JSX/TSX');
    expect(report.languages).toContain('SCSS');
    expect(report.elementSupport).toContain('.tsx');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('jsx index: ranges, attrs, classes, ancestors', () => {
  const idx = indexJsx(
    'a.tsx',
    `export function A() { return (<main className="x y"><p id="t" data-testid="tt">Hi {name}</p></main>); }`
  );
  const main = idx.elements.find((e) => e.tag === 'main')!;
  const p = idx.elements.find((e) => e.tag === 'p')!;
  expect(main.classes).toEqual(['x', 'y']);
  expect(p.id).toBe('t');
  expect(p.testId).toBe('tt');
  expect(p.text).toBe('Hi');
  expect(p.ancestors).toEqual(['main']);
  expect(p.parent).toBe(idx.elements.indexOf(main));
  const src = `export function A() { return (<main className="x y"><p id="t" data-testid="tt">Hi {name}</p></main>); }`;
  expect(src.slice(main.start, main.end).startsWith('<main')).toBe(true);
  expect(src.slice(main.start, main.end).endsWith('</main>')).toBe(true);
});

test('sfc index: vue template offsets and style blocks', () => {
  const code = `<template><main><p class="a">Hi</p></main></template>\n<style scoped>.a { color: red; }</style>\n`;
  const idx = indexSfc('a.vue', code);
  const p = idx.elements.find((e) => e.tag === 'p')!;
  expect(code.slice(p.start, p.end)).toBe('<p class="a">Hi</p>');
  expect(idx.styleBlocks.length).toBe(1);
  expect(code.slice(idx.styleBlocks[0].contentStart, idx.styleBlocks[0].contentEnd)).toBe(
    '.a { color: red; }'
  );
});
