import { test, expect } from 'vitest';
import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  decodeMappings,
  lookupOriginal,
  resolveTrackedSource,
  extractJsxElement,
  locateCorresponding,
  referencedIdentifiers,
  availableIdentifiers,
  frameworkElementCandidate
} from '../../src/branches/framework';
import { HistoryStore } from '../../src/store/store';

const APP_HISTORICAL = `import { useState } from 'react';

function Banner() {
  return <section className="banner"><h2>Special offer</h2><p>Half price today</p></section>;
}

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>Shop</h1>
      <Banner />
      <button id="cta" onClick={() => setCount(count + 1)}>Clicked {count} times</button>
      <ul>
        <li key="a">Alpha</li>
        <li key="b">Beta</li>
      </ul>
    </main>
  );
}
`;
const APP_CURRENT = APP_HISTORICAL.replace('Half price today', 'Full price now').replace(
  'Clicked {count} times',
  'Clicked {count} of 10'
);

async function buildFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-fw-'));
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'App.tsx'), APP_HISTORICAL);
  await fs.writeFile(
    path.join(dir, 'src', 'main.tsx'),
    `import { createRoot } from 'react-dom/client';\nimport { App } from './App';\nexport { App };\n`
  );
  await esbuild.build({
    entryPoints: [path.join(dir, 'src', 'main.tsx')],
    bundle: true,
    jsx: 'automatic',
    jsxDev: true,
    sourcemap: true,
    outfile: path.join(dir, 'bundle.js'),
    external: ['react', 'react-dom'],
    logLevel: 'silent'
  });
  const map = JSON.parse(await fs.readFile(path.join(dir, 'bundle.js.map'), 'utf8'));
  return { dir, map };
}

/** Locate the generated jsxDEV call for the given source marker comment. */
async function mappedPosition(marker: string) {
  const { dir, map } = await buildFixture();
  const bundle = await fs.readFile(path.join(dir, 'bundle.js'), 'utf8');
  const lines = bundle.split('\n');
  const idx = lines.findIndex((l) => l.includes(marker));
  expect(idx).toBeGreaterThan(-1);
  const col = lines[idx].indexOf('jsxDEV') + 1;
  try {
    return lookupOriginal(map, idx + 1, col);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('source map decode resolves generated positions to original tsx lines', async () => {
  const cta = await mappedPosition('id: "cta"');
  expect(cta?.source.replace(/\\/g, '/')).toContain('src/App.tsx');
  const line = APP_HISTORICAL.split('\n')[cta!.line - 1];
  expect(line).toContain('<button id="cta"');
});

test('extractJsxElement finds the element, component, occurrence and skeleton', () => {
  const line = APP_HISTORICAL.split('\n').findIndex((l) => l.includes('<button id="cta"')) + 1;
  const col = APP_HISTORICAL.split('\n')[line - 1].indexOf('<button') + 1;
  const el = extractJsxElement(APP_HISTORICAL, line, col)!;
  expect(el.tagName).toBe('button');
  expect(el.componentName).toBe('App');
  expect(el.text).toContain('Clicked {count} times');
  expect(el.skeleton).toEqual(['main', 'h1', 'banner', 'button', 'ul', 'li', 'li']);
  const items = el.occurrenceIndex;
  expect(items).toBe(0);
});

test('locateCorresponding restores the changed element at the same position', () => {
  const line = APP_HISTORICAL.split('\n').findIndex((l) => l.includes('<p>Half price')) + 1;
  const col = APP_HISTORICAL.split('\n')[line - 1].indexOf('<p>') + 1;
  const historical = extractJsxElement(APP_HISTORICAL, line, col)!;
  expect(historical.componentName).toBe('Banner');
  const located = locateCorresponding(APP_CURRENT, historical);
  expect('range' in located).toBe(true);
  if ('range' in located)
    expect(APP_CURRENT.slice(located.range.start, located.range.end)).toContain('Full price now');
});

test('reorder and duplication change the skeleton and are refused', () => {
  const line = APP_HISTORICAL.split('\n').findIndex((l) => l.includes('<h2>')) + 1;
  const col = APP_HISTORICAL.split('\n')[line - 1].indexOf('<h2>') + 1;
  const historical = extractJsxElement(APP_HISTORICAL, line, col)!;
  const reordered = APP_HISTORICAL.replace(
    '<h2>Special offer</h2><p>Half price today</p>',
    '<p>Half price today</p><h2>Special offer</h2>'
  );
  const r1 = locateCorresponding(reordered, historical);
  expect('refusal' in r1 && r1.refusal).toContain('structure changed');
  const duplicated = APP_HISTORICAL.replace(
    '<h2>Special offer</h2>',
    '<h2>Special offer</h2><h2>Twice</h2>'
  );
  const r2 = locateCorresponding(duplicated, historical);
  expect('refusal' in r2).toBe(true);
});

test('missing component is refused', () => {
  const line = APP_HISTORICAL.split('\n').findIndex((l) => l.includes('<h2>')) + 1;
  const col = APP_HISTORICAL.split('\n')[line - 1].indexOf('<h2>') + 1;
  const historical = extractJsxElement(APP_HISTORICAL, line, col)!;
  const withoutBanner = APP_HISTORICAL.replace(/function Banner[\s\S]*?\n}\n/, '');
  const r = locateCorresponding(withoutBanner, historical);
  expect('refusal' in r && r.refusal).toContain('Banner');
});

test('resolveTrackedSource accepts dev URLs and rejects ambiguity and escapes', () => {
  const files = [{ path: 'src/App.tsx' }, { path: 'index.html' }];
  expect(resolveTrackedSource('http://127.0.0.1:4100/src/App.tsx', files)).toBe('src/App.tsx');
  expect(resolveTrackedSource('/src/App.tsx?t=123', files)).toBe('src/App.tsx');
  expect(resolveTrackedSource('/src/App.css', files)).toBeUndefined();
  expect(resolveTrackedSource('/other/App.tsx', files)).toBeUndefined();
  const dup = [...files, { path: 'a/src/App.tsx' }];
  // Both tracked files suffix-match: ambiguity is refused, never guessed.
  expect(resolveTrackedSource('/a/src/App.tsx', dup)).toBeUndefined();
  expect(resolveTrackedSource('/src/App.tsx', dup)).toBe('src/App.tsx');
});

test('dependency guard: missing handler refused, available handler accepted', () => {
  const src = `import { useState } from 'react';
export function App() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Clicked {count}</button>;
}
`;
  const line = 4;
  const col = src.split('\n')[3].indexOf('<button') + 1;
  const el = extractJsxElement(src, line, col)!;
  const needed = referencedIdentifiers(src, el.start, el.end);
  expect(needed).toContain('setCount');
  expect(needed).toContain('count');
  const available = availableIdentifiers(src, 'App');
  for (const n of needed) expect(available.has(n)).toBe(true);
  const stripped = src.replace('const [count, setCount] = useState(0);\n  ', '');
  const missing = needed.filter((n) => !availableIdentifiers(stripped, 'App').has(n));
  expect(missing).toEqual(['count', 'setCount']);
});

async function storePair(historical: string, current: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-fwstore-'));
  const store = new HistoryStore(dir);
  await store.open();
  const { hashBytes } = await import('../../src/store/store');
  const entry = (text: string) => {
    const bytes = Buffer.from(text);
    return {
      files: [{ path: 'src/App.tsx', hash: hashBytes(bytes), mode: 0o644, size: bytes.length }],
      contents: new Map([['src/App.tsx', bytes]])
    };
  };
  const a = entry(historical);
  const oldCp = await store.commit(a.files, a.contents, 'save', { kind: 'unattributed' });
  const b = entry(current);
  const nowCp = await store.commit(b.files, b.contents, 'save', { kind: 'unattributed' });
  return { dir, store, oldCp, nowCp };
}

test('frameworkElementCandidate restores one element and refuses tag mismatch', async () => {
  const { dir, store, oldCp, nowCp } = await storePair(APP_HISTORICAL, APP_CURRENT);
  try {
    const line = APP_HISTORICAL.split('\n').findIndex((l) => l.includes('<button id="cta"')) + 1;
    const col = APP_HISTORICAL.split('\n')[line - 1].indexOf('<button') + 1;
    const candidate = await frameworkElementCandidate(store, oldCp, nowCp, {
      frame: { fileName: '/src/App.tsx', lineNumber: line, columnNumber: col },
      tag: 'button'
    });
    const text = (
      await store.readBlob(candidate.files.find((f) => f.path === 'src/App.tsx')!.hash)
    ).toString('utf8');
    expect(text).toContain('Clicked {count} times');
    expect(text).toContain('Full price now');
    await expect(
      frameworkElementCandidate(store, oldCp, nowCp, {
        frame: { fileName: '/src/App.tsx', lineNumber: line, columnNumber: col },
        tag: 'section'
      })
    ).rejects.toThrow('<button>');
    await expect(
      frameworkElementCandidate(store, oldCp, nowCp, {
        frame: { fileName: '/src/Missing.tsx', lineNumber: 1, columnNumber: 1 },
        tag: 'div'
      })
    ).rejects.toThrow('not tracked');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('frameworkElementCandidate refuses missing dependencies and unchanged elements', async () => {
  const currentMissingHandler = APP_CURRENT.replace(
    'const [count, setCount] = useState(0);',
    'const count = 0;'
  );
  const pair = await storePair(APP_HISTORICAL, currentMissingHandler);
  const same = await storePair(APP_HISTORICAL, APP_HISTORICAL);
  try {
    const line = APP_HISTORICAL.split('\n').findIndex((l) => l.includes('<button id="cta"')) + 1;
    const col = APP_HISTORICAL.split('\n')[line - 1].indexOf('<button') + 1;
    await expect(
      frameworkElementCandidate(pair.store, pair.oldCp, pair.nowCp, {
        frame: { fileName: '/src/App.tsx', lineNumber: line, columnNumber: col },
        tag: 'button'
      })
    ).rejects.toThrow('setCount');
    await expect(
      frameworkElementCandidate(same.store, same.oldCp, same.nowCp, {
        frame: { fileName: '/src/App.tsx', lineNumber: line, columnNumber: col },
        tag: 'button'
      })
    ).rejects.toThrow('already matches');
  } finally {
    await fs.rm(pair.dir, { recursive: true, force: true });
    await fs.rm(same.dir, { recursive: true, force: true });
  }
});

test('decodeMappings rejects invalid encodings', () => {
  expect(() => decodeMappings('###')).toThrow();
  expect(Array.isArray(decodeMappings('AAAA'))).toBe(true);
});
