import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HistoryStore } from '../../src/store/store';
import { scan } from '../../src/capture/scanner';
import { elementCandidate } from '../../src/branches/element';
test('plain HTML element restores content and owned CSS, preserving unrelated current markup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-element-'));
  try {
    const work = path.join(root, 'project');
    await fs.mkdir(work);
    const store = new HistoryStore(path.join(root, 'history'));
    await store.open();
    const capture = async (html: string, css: string) => {
      await fs.writeFile(path.join(work, 'index.html'), html);
      await fs.writeFile(path.join(work, 'site.css'), css);
      const s = await scan(work, store.root);
      return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    };
    const old = await capture(
      '<link rel="stylesheet" href="site.css"><main><section id="hero" style="padding:8px"><b>Old</b></section><p>Original</p></main>',
      'body{margin:0}#hero{color:red}'
    );
    const now = await capture(
      '<link rel="stylesheet" href="site.css"><main><section id="hero" style="padding:20px">New</section><p>Keep current</p></main>',
      'body{margin:0}#hero{color:blue}'
    );
    const target = await elementCandidate(store, old, now, 'index.html', 'hero');
    const html = (
      await store.readBlob(target.files.find((f) => f.path === 'index.html')!.hash)
    ).toString();
    const css = (
      await store.readBlob(target.files.find((f) => f.path === 'site.css')!.hash)
    ).toString();
    expect(html).toContain('<section id="hero" style="padding:8px"><b>Old</b></section>');
    expect(html).toContain('<p>Keep current</p>');
    expect(css).toContain('#hero{color:red}');
    expect(await fs.readFile(path.join(work, 'site.css'), 'utf8')).toContain('blue');
    const shared = await capture(
      '<link rel="stylesheet" href="site.css"><section id="hero">New</section>',
      'body{margin:20px}#hero{color:blue}'
    );
    const sharedTarget = await elementCandidate(store, old, shared, 'index.html', 'hero');
    expect(
      (await store.readBlob(sharedTarget.files.find((f) => f.path === 'site.css')!.hash)).toString()
    ).toContain('margin:20px');
    const duplicate = await capture('<section id="hero">A</section><div id="hero">B</div>', '');
    await expect(elementCandidate(store, old, duplicate, 'index.html', 'hero')).rejects.toThrow(
      'Cannot map'
    );
    const active = await capture('<script>doStuff()</script><section id="hero">New</section>', '');
    await expect(elementCandidate(store, active, now, 'index.html', 'hero')).rejects.toThrow(
      'active HTML'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('mouse path selects no-id navbar and restores its class CSS without footer rollback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-mouse-'));
  try {
    const work = path.join(root, 'project');
    await fs.mkdir(work);
    const store = new HistoryStore(path.join(root, 'history'));
    await store.open();
    const capture = async (html: string, css: string) => {
      await fs.writeFile(path.join(work, 'index.html'), html);
      await fs.writeFile(path.join(work, 'site.css'), css);
      const s = await scan(work, store.root);
      return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    };
    const old = await capture(
      '<link rel="stylesheet" href="site.css"><nav><strong class="brand">Old</strong></nav><footer>Old footer</footer>',
      'body{margin:0}nav{color:red}nav .brand{font-size:22px}'
    );
    const now = await capture(
      '<link rel="stylesheet" href="site.css"><nav><strong class="brand">New</strong></nav><footer>Current footer</footer>',
      'body{margin:0}nav{color:blue}nav .brand{font-size:30px}'
    );
    const candidate = await elementCandidate(store, old, now, 'index.html', '', [0]);
    expect(
      (await store.readBlob(candidate.files.find((f) => f.path === 'index.html')!.hash)).toString()
    ).toContain('<nav><strong class="brand">Old</strong></nav><footer>Current footer</footer>');
    expect(
      (await store.readBlob(candidate.files.find((f) => f.path === 'site.css')!.hash)).toString()
    ).toContain('color:red');
    const shifted = await capture(
      '<link rel="stylesheet" href="site.css"><aside>Inserted</aside><nav><strong class="brand">New</strong></nav><footer>Current footer</footer>',
      'body{margin:0}nav{color:blue}nav .brand{font-size:30px}'
    );
    const moved = await elementCandidate(store, old, shifted, 'index.html', '', [0]);
    expect(
      (await store.readBlob(moved.files.find((f) => f.path === 'index.html')!.hash)).toString()
    ).toContain('<aside>Inserted</aside><nav><strong class="brand">Old</strong></nav>');
    const duplicate = await capture(
      '<link rel="stylesheet" href="site.css"><nav>A</nav><nav>B</nav>',
      'body{margin:0}nav{color:blue}nav .brand{font-size:30px}'
    );
    await expect(elementCandidate(store, old, duplicate, 'index.html', '', [0])).rejects.toThrow(
      'Cannot map'
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('responsive index page keeps unchanged shared tokens and restores exclusive media/supports rules', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-responsive-'));
  const work = path.join(root, 'work');
  await fs.mkdir(work);
  const store = new HistoryStore(path.join(root, 'history'));
  await store.open();
  try {
    const capture = async (text: string, size: string) => {
      await fs.writeFile(
        path.join(work, 'index.html'),
        `<link rel="stylesheet" href="site.css"><main><section class="hero"><h2>Repeated</h2><p>${text}</p></section><section class="cards"><article class="card"><h2>One</h2></article><article class="card"><h2>Two</h2></article></section></main>`
      );
      await fs.writeFile(
        path.join(work, 'site.css'),
        `:root{--accent:red}*{box-sizing:border-box}h2{color:var(--accent)}.hero:hover{padding:${size}}@media(max-width:700px){.hero{gap:${size}}.card{padding:8px}}@supports(display:grid){.hero{display:grid;gap:${size}}}`
      );
      const s = await scan(work, store.root);
      return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    };
    const old = await capture('Saved', '10px'),
      now = await capture('Current', '30px');
    const cp = await elementCandidate(store, old, now, 'index.html', '', [0, 0]);
    const css = (
      await store.readBlob(cp.files.find((f) => f.path === 'site.css')!.hash)
    ).toString();
    expect(css).toContain('gap:10px');
    expect(css).toContain('var(--accent)');
    const repeated = await elementCandidate(store, now, now, 'index.html', '', [0, 1, 1, 0]);
    expect(
      (await store.readBlob(repeated.files.find((f) => f.path === 'index.html')!.hash)).toString()
    ).toContain('<h2>Two</h2>');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('actual web-lab index accepts ordinary visible elements, repeated card headings and responsive styling', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-index-'));
  const work = path.join(root, 'work');
  await fs.cp(path.resolve('../../fixtures/web-lab-index'), work, { recursive: true });
  const store = new HistoryStore(path.join(root, 'history'));
  await store.open();
  try {
    const capture = async () => {
      const s = await scan(work, store.root);
      return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    };
    const old = await capture();
    for (const indices of [
      [0],
      [0, 0],
      [0, 1, 1],
      [1, 0],
      [1, 0, 0, 1],
      [1, 1],
      [1, 1, 0],
      [1, 1, 1, 1],
      [1, 2, 1, 0],
      [1, 2, 2, 0]
    ])
      await expect(
        elementCandidate(store, old, old, 'index.html', '', indices)
      ).resolves.toBeDefined();
    const html = await fs.readFile(path.join(work, 'index.html'), 'utf8');
    await fs.writeFile(
      path.join(work, 'index.html'),
      html
        .replace('Your next workspace starts here.', 'Current announcement')
        .replace('Northline · Local', 'Keep footer · Local')
    );
    const css = await fs.readFile(path.join(work, 'site.css'), 'utf8');
    await fs.writeFile(
      path.join(work, 'site.css'),
      css
        .replace('gap: 16px; padding: 24px;', 'gap: 30px; padding: 32px;')
        .replace('background: #fbbf24; color: #241b0e;', 'background: #ff9900; color: #241b0e;')
    );
    const now = await capture(),
      candidate = await elementCandidate(store, old, now, 'index.html', '', [1, 0]);
    const restored = (
      await store.readBlob(candidate.files.find((f) => f.path === 'index.html')!.hash)
    ).toString();
    expect(restored).toContain('Your next workspace starts here.');
    expect(restored).toContain('Keep footer');
    expect(
      (await store.readBlob(candidate.files.find((f) => f.path === 'site.css')!.hash)).toString()
    ).toBe(css);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('Studio ancestor theme edits, shared CSS edits and SVG shapes do not veto ordinary mouse picks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-studio-'));
  const work = path.join(root, 'work');
  await fs.mkdir(work);
  const store = new HistoryStore(path.join(root, 'history'));
  await store.open();
  try {
    const html = await fs.readFile('../../fixtures/web-lab-studio/index.html', 'utf8');
    const css = await fs.readFile('../../fixtures/web-lab-studio/site.css', 'utf8');
    const capture = async (h: string, c: string) => {
      await fs.writeFile(path.join(work, 'index.html'), h);
      await fs.writeFile(path.join(work, 'site.css'), c);
      const s = await scan(work, store.root);
      return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    };
    const old = await capture(html.replace('theme-charcoal theme-amber', 'theme-light'), css);
    const current = await capture(
      html
        .replace('A calmer place to work.', 'Current title')
        .replace('Natural textures. More room to think.', 'Keep current card'),
      css.replace('--bg-page: #121316', '--bg-page: #eeeeee')
    );
    const { parse } = await import('parse5');
    const tree = parse(html) as unknown as { tagName?: string; childNodes?: unknown[] };
    const paths: { tag: string; path: number[] }[] = [];
    const visit = (n: typeof tree, path: number[]) => {
      if (n.tagName) paths.push({ tag: n.tagName, path });
      for (const [i, child] of (n.childNodes ?? [])
        .filter((n) => (n as typeof tree).tagName)
        .entries())
        visit(child as typeof tree, [...path, i]);
    };
    const findBody = (n: typeof tree): typeof tree | undefined =>
      n.tagName === 'body'
        ? n
        : (n.childNodes ?? []).map((n) => findBody(n as typeof tree)).find(Boolean);
    visit(findBody(tree)!, []);
    for (const { tag, path: indices } of paths.filter((p) =>
      ['a', 'svg', 'ellipse', 'rect', 'path', 'h1', 'h2', 'p'].includes(p.tag)
    )) {
      const result = await elementCandidate(store, old, current, 'index.html', '', indices);
      const resultCss = (
        await store.readBlob(result.files.find((f) => f.path === 'site.css')!.hash)
      ).toString();
      expect(resultCss, tag).toContain('--bg-page: #eeeeee');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

import { assertSplicePreserves } from '../../src/branches/element';

test('assertSplicePreserves passes when elements outside the replaced range survive', () => {
  const nowHtml =
    '<main><section id="a"><b>One</b></section><section id="b">Two</section><p id="tail">Keep</p></main>';
  // Replace <section id="a">...</section> with a shorter subtree; everything else untouched.
  const start = nowHtml.indexOf('<section id="a">');
  const end = nowHtml.indexOf('</section>', start) + '</section>'.length;
  const result =
    nowHtml.slice(0, start) + '<section id="a"><i>Restored</i></section>' + nowHtml.slice(end);
  expect(() => assertSplicePreserves(nowHtml, start, end, result, end - start)).not.toThrow();
});

test('assertSplicePreserves throws when parse recovery silently drops an outside element', () => {
  const nowHtml =
    '<main><section id="a"><b>One</b></section><section id="b">Two</section><p id="tail">Keep</p></main>';
  const start = nowHtml.indexOf('<section id="a">');
  const end = nowHtml.indexOf('</section>', start) + '</section>'.length;
  const inserted = '<section id="a"><i>Restored</i></section>';
  // A bad splice can leave the sibling mis-nested; parse5 then drops it
  // (a <td> outside table context is discarded by the HTML parser). The
  // element disappears without any error - the exact "revert works 70%"
  // failure class this guard exists to refuse.
  const result =
    nowHtml.slice(0, start) + inserted + '<td id="b">Two</td><p id="tail">Keep</p></main>';
  expect(result.includes('id="b"')).toBe(true); // text is there; the parser drops it
  expect(() => assertSplicePreserves(nowHtml, start, end, result, inserted.length)).toThrow(
    /would vanish/
  );
});

import { mergePreservingAdditions } from '../../src/branches/element';

test('mergePreservingAdditions restores old children and keeps added elements', () => {
  const oldSlice =
    '<section id="hero"><h1 id="title">Old title</h1><button id="cta">Buy</button></section>';
  const nowSlice =
    '<section id="hero"><h1 id="title">New title</h1><button id="cta">Buy now</button><a id="promo" href="/sale">Sale</a></section>';
  const merged = mergePreservingAdditions(oldSlice, nowSlice);
  expect(merged).toContain('Old title'); // matched child reverts to the old version
  expect(merged).not.toContain('New title');
  expect(merged).toContain('id="promo"'); // the added element survives
  expect(merged.indexOf('id="promo"')).toBeGreaterThan(merged.indexOf('id="cta"')); // appended after restored children
});

test('mergePreservingAdditions keeps added elements without ids (tag+index matching)', () => {
  const oldSlice = '<ul><li>One</li></ul>';
  const nowSlice = '<ul><li>One changed</li><li>Two added</li></ul>';
  const merged = mergePreservingAdditions(oldSlice, nowSlice);
  expect(merged).toBe('<ul><li>One</li><li>Two added</li></ul>');
});

test('mergePreservingAdditions returns the old slice unchanged when nothing was added', () => {
  const oldSlice = '<div><p>Same</p></div>';
  const nowSlice = '<div><p>Same but edited</p></div>';
  expect(mergePreservingAdditions(oldSlice, nowSlice)).toBe(oldSlice);
});

test('element revert keeps elements added inside the target after the old checkpoint', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-threeway-'));
  try {
    const work = path.join(root, 'project');
    await fs.mkdir(work);
    const store = new HistoryStore(path.join(root, 'history'));
    await store.open();
    const capture = async (html: string, css: string) => {
      await fs.writeFile(path.join(work, 'index.html'), html);
      await fs.writeFile(path.join(work, 'site.css'), css);
      const s = await scan(work, store.root);
      return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    };
    const old = await capture(
      '<link rel="stylesheet" href="site.css"><main><section id="hero" style="padding:8px"><b>Old</b></section></main>',
      'body{margin:0}#hero{color:red}'
    );
    const now = await capture(
      '<link rel="stylesheet" href="site.css"><main><section id="hero" style="padding:20px">New<a id="promo" href="/sale">Sale</a></section></main>',
      'body{margin:0}#hero{color:blue}'
    );
    const target = await elementCandidate(store, old, now, 'index.html', 'hero');
    const html = (
      await store.readBlob(target.files.find((f) => f.path === 'index.html')!.hash)
    ).toString();
    expect(html).toContain('<b>Old</b>'); // reverted content
    expect(html).toContain('id="promo"'); // addition kept
    expect(html).not.toContain('>New<');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('sitewide element change applies to matching pages and skips the rest with reasons', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-sitewide-'));
  try {
    const work = path.join(root, 'project');
    await fs.mkdir(work);
    const store = new HistoryStore(path.join(root, 'history'));
    await store.open();
    const capture = async (files: Record<string, string>) => {
      for (const [name, content] of Object.entries(files))
        await fs.writeFile(path.join(work, name), content);
      const s = await scan(work, store.root);
      return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    };
    // Source: the navbar as it should become (picked from this checkpoint).
    const source = await capture({
      'index.html': '<main><nav id="nav"><b>V1</b></nav><p>source</p></main>'
    });
    // Current: index drifts, about keeps its own footer, contact lacks the
    // element, guide is ambiguous, docs uses a different stylesheet list.
    const current = await capture({
      'index.html': '<main><nav id="nav"><b>V2</b></nav><p>Keep current</p></main>',
      'about.html': '<nav id="nav"><b>V2-other</b></nav><footer>About footer</footer>',
      'contact.html': '<p>No navigation here</p>',
      'guide.html': '<nav id="nav">A</nav><nav id="nav">B</nav>',
      'docs.html':
        '<link rel="stylesheet" href="docs.css"><nav id="nav"><b>V2-docs</b></nav>',
      'docs.css': '#nav{color:black}'
    });
    const { elementCandidateAcrossDocuments } = await import('../../src/branches/element');
    const result = await elementCandidateAcrossDocuments(
      store,
      source,
      current,
      'index.html',
      'nav',
      undefined,
      ['index.html', 'about.html', 'contact.html', 'guide.html', 'docs.html']
    );
    expect(result.applied).toEqual(['index.html', 'about.html']);
    const skippedByDoc = new Map(result.skipped.map((s) => [s.document, s.reason]));
    expect(skippedByDoc.get('contact.html')).toMatch('found 0 matching elements');
    expect(skippedByDoc.get('guide.html')).toMatch('found 2 matching elements');
    expect(skippedByDoc.get('docs.html')).toMatch('Stylesheet list differs');
    const read = async (p: string) =>
      (await store.readBlob(result.candidate.files.find((f) => f.path === p)!.hash)).toString();
    // The picked page restores the element and keeps unrelated current markup.
    expect(await read('index.html')).toContain('<nav id="nav"><b>V1</b></nav>');
    expect(await read('index.html')).toContain('<p>Keep current</p>');
    // The matching page gets the same element; its own content survives.
    expect(await read('about.html')).toContain('<nav id="nav"><b>V1</b></nav>');
    expect(await read('about.html')).toContain('<footer>About footer</footer>');
    // Skipped pages are byte-identical to current.
    expect(await read('contact.html')).toBe('<p>No navigation here</p>');
    expect(await read('guide.html')).toBe('<nav id="nav">A</nav><nav id="nav">B</nav>');
    expect(await read('docs.html')).toContain('V2-docs');
    // Workspace files were never touched.
    expect(await fs.readFile(path.join(work, 'about.html'), 'utf8')).toContain('V2-other');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('sitewide element change refuses scripted target pages instead of applying', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-sitewide-safe-'));
  try {
    const work = path.join(root, 'project');
    await fs.mkdir(work);
    const store = new HistoryStore(path.join(root, 'history'));
    await store.open();
    const capture = async (files: Record<string, string>) => {
      for (const [name, content] of Object.entries(files))
        await fs.writeFile(path.join(work, name), content);
      const s = await scan(work, store.root);
      return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    };
    const source = await capture({ 'index.html': '<nav id="nav">V1</nav>' });
    const current = await capture({
      'index.html': '<nav id="nav">V2</nav>',
      'app.html': '<script>doStuff()</script><nav id="nav">V2</nav>'
    });
    const { elementCandidateAcrossDocuments } = await import('../../src/branches/element');
    const result = await elementCandidateAcrossDocuments(
      store,
      source,
      current,
      'index.html',
      'nav',
      undefined,
      ['index.html', 'app.html']
    );
    expect(result.applied).toEqual(['index.html']);
    expect(result.skipped[0].document).toBe('app.html');
    expect(result.skipped[0].reason).toMatch('Scripted or active HTML');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
