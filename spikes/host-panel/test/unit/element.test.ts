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
    await expect(elementCandidate(store, old, shared, 'index.html', 'hero')).rejects.toThrow(
      'Shared or unsupported CSS changed'
    );
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
