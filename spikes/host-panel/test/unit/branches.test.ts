import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HistoryStore } from '../../src/store/store';
import { scan, defaultLimits } from '../../src/capture/scanner';
import { Alternatives, mergeFiles } from '../../src/branches/alternatives';
import { Restore } from '../../src/review/restore';
import { staticNavbarPaths, staticSectionPaths } from '../../src/branches/static-mapping';
import { resolveElementFiles, mergeMultiElements } from '../../src/branches/multi-merge';
import { validateCandidate } from '../../src/branches/validate';
async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-branches-'));
  const root = path.join(temp, 'project');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'navbar.html'), '<nav>Old</nav>');
  await fs.writeFile(path.join(root, 'footer.html'), '<footer>Original</footer>');
  const store = new HistoryStore(path.join(temp, 'history'));
  await store.open();
  const s = await scan(root, store.root);
  const base = await store.commit(s.files, s.contents, 'baseline', { kind: 'unattributed' });
  return { temp, root, store, base, alternatives: new Alternatives(store, defaultLimits) };
}
test('forks isolate bytes, survive restart, retain lineage and original workspace head', async () => {
  const f = await fixture();
  try {
    const a = await f.alternatives.fork(f.base, 'Navbar');
    const b = await f.alternatives.fork(f.base, 'Other');
    await fs.writeFile(path.join(a.directory, 'navbar.html'), '<nav>New</nav>');
    const selected = await f.alternatives.capture(a.id);
    expect(selected.parentId).toBe(a.checkpoint);
    expect(await fs.readFile(path.join(b.directory, 'navbar.html'), 'utf8')).toBe('<nav>Old</nav>');
    expect(await fs.readFile(path.join(f.root, 'navbar.html'), 'utf8')).toBe('<nav>Old</nav>');
    const restored = new HistoryStore(f.store.root);
    await restored.open();
    expect(restored.checkpoints.at(-1)!.id).toBe(f.base.id);
    expect(new Alternatives(restored, defaultLimits).list()).toHaveLength(2);
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});
test('six distinct alternatives survive captures and restart without a two-item cap', async () => {
  const f = await fixture();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const branch = await f.alternatives.fork(f.base, 'Studio option ' + (i + 1));
      ids.push(branch.id);
      await fs.writeFile(path.join(branch.directory, 'navbar.html'), '<nav>Option ' + i + '</nav>');
      await f.alternatives.capture(branch.id);
    }
    expect(
      f.alternatives
        .list()
        .map((b) => b.id)
        .sort()
    ).toEqual(ids.sort());
    const reopened = new HistoryStore(f.store.root);
    await reopened.open();
    expect(new Alternatives(reopened, defaultLimits).list()).toHaveLength(6);
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});
test('navbar file apply preserves independently changed footer, creates safety and Undo', async () => {
  const f = await fixture();
  try {
    const b = await f.alternatives.fork(f.base, 'Nav');
    await fs.writeFile(path.join(b.directory, 'navbar.html'), '<nav>New</nav>');
    const selected = await f.alternatives.capture(b.id);
    await fs.writeFile(path.join(f.root, 'footer.html'), '<footer>Edited</footer>');
    const s = await scan(f.root, f.store.root);
    const current = await f.store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    const mapping = await staticNavbarPaths(f.store, selected, 'navbar.html');
    const merged = mergeFiles(f.base, current, selected, mapping);
    expect(merged.conflicts).toEqual([]);
    const r = new Restore(f.root, f.store, defaultLimits);
    const review = await r.review(merged.target, current, false);
    expect(review.paths).toEqual(['navbar.html']);
    await r.apply(review.token, merged.target, false);
    expect(await fs.readFile(path.join(f.root, 'footer.html'), 'utf8')).toBe(
      '<footer>Edited</footer>'
    );
    expect(await fs.readFile(path.join(f.root, 'navbar.html'), 'utf8')).toBe('<nav>New</nav>');
    await r.undo(f.store.checkpoints.at(-1)!, false);
    expect(await fs.readFile(path.join(f.root, 'navbar.html'), 'utf8')).toBe('<nav>Old</nav>');
    expect(await fs.readFile(path.join(b.directory, 'navbar.html'), 'utf8')).toBe('<nav>New</nav>');
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});
for (const mode of ['both-edited', 'delete-edit', 'rename-edit'])
  test(`three-way ${mode} rejected`, async () => {
    const f = await fixture();
    try {
      const b = await f.alternatives.fork(f.base, 'Conflict');
      if (mode === 'delete-edit') await fs.unlink(path.join(b.directory, 'navbar.html'));
      else if (mode === 'rename-edit')
        await fs.rename(
          path.join(b.directory, 'navbar.html'),
          path.join(b.directory, 'newnav.html')
        );
      else await fs.writeFile(path.join(b.directory, 'navbar.html'), '<nav>Branch</nav>');
      const selected = await f.alternatives.capture(b.id);
      await fs.writeFile(path.join(f.root, 'navbar.html'), '<nav>Workspace</nav>');
      const s = await scan(f.root, f.store.root);
      const current = await f.store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
      expect(mergeFiles(f.base, current, selected, ['navbar.html']).conflicts).toEqual([
        'navbar.html'
      ]);
    } finally {
      await fs.rm(f.temp, { recursive: true, force: true });
    }
  });
test('shared CSS and embedded element ownership rejected; isolated build/test pass and failure', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(
      path.join(f.root, 'navbar.html'),
      '<link rel="stylesheet" href="styles.css"><nav>Old</nav>'
    );
    await fs.writeFile(
      path.join(f.root, 'footer.html'),
      '<link rel="stylesheet" href="styles.css"><footer>Old</footer>'
    );
    await fs.writeFile(path.join(f.root, 'styles.css'), 'nav{color:red}');
    const s = await scan(f.root, f.store.root);
    const cp = await f.store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    await expect(staticNavbarPaths(f.store, cp, 'navbar.html')).rejects.toThrow('Shared CSS');
    await validateCandidate('node -e "process.exit(0)"', f.root);
    await expect(validateCandidate('node -e "process.exit(1)"', f.root)).rejects.toThrow('failed');
    await expect(validateCandidate('', f.root)).rejects.toThrow('command');
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});

test('unique static navbar CSS allowed; mixed document and framework mapping refused', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(
      path.join(f.root, 'navbar.html'),
      '<link rel="stylesheet" href="navbar.css"><nav><span class="label">New</span></nav>'
    );
    await fs.writeFile(
      path.join(f.root, 'navbar.css'),
      'nav{color:blue}nav .label{font-weight:600}'
    );
    let scanResult = await scan(f.root, f.store.root);
    let cp = await f.store.commit(scanResult.files, scanResult.contents, 'save', {
      kind: 'unattributed'
    });
    expect(await staticNavbarPaths(f.store, cp, 'navbar.html')).toEqual([
      'navbar.html',
      'navbar.css'
    ]);
    await fs.writeFile(path.join(f.root, 'navbar.html'), '<nav>New</nav><div>Other area</div>');
    scanResult = await scan(f.root, f.store.root);
    cp = await f.store.commit(scanResult.files, scanResult.contents, 'save', {
      kind: 'unattributed'
    });
    await expect(staticNavbarPaths(f.store, cp, 'navbar.html')).rejects.toThrow('ownership');
    await expect(staticNavbarPaths(f.store, cp, 'Navbar.tsx')).rejects.toThrow('static HTML');
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});

test('staticSectionPaths supports any standalone semantic section and rejects mixed or script content', async () => {
  const f = await fixture();
  try {
    // 1. Standalone footer with unique CSS
    await fs.writeFile(
      path.join(f.root, 'footer.html'),
      '<link rel="stylesheet" href="footer.css"><footer><small class="copy">Scrubline</small></footer>'
    );
    await fs.writeFile(
      path.join(f.root, 'footer.css'),
      'footer{background:#000}footer .copy{color:#fff}'
    );
    let s = await scan(f.root, f.store.root);
    let cp = await f.store.commit(s.files, s.contents, 'save-footer', { kind: 'unattributed' });
    expect(await staticSectionPaths(f.store, cp, 'footer.html')).toEqual([
      'footer.html',
      'footer.css'
    ]);

    // 2. Standalone section with heading + paragraph
    await fs.writeFile(
      path.join(f.root, 'hero.html'),
      '<section><h1>Hero Heading</h1><p>Description text</p></section>'
    );
    s = await scan(f.root, f.store.root);
    cp = await f.store.commit(s.files, s.contents, 'save-section', { kind: 'unattributed' });
    expect(await staticSectionPaths(f.store, cp, 'hero.html')).toEqual(['hero.html']);

    // 3. Standalone aside with navigation
    await fs.writeFile(
      path.join(f.root, 'sidebar.html'),
      '<aside><ul><li><a href="#link">Item</a></li></ul></aside>'
    );
    s = await scan(f.root, f.store.root);
    cp = await f.store.commit(s.files, s.contents, 'save-aside', { kind: 'unattributed' });
    expect(await staticSectionPaths(f.store, cp, 'sidebar.html')).toEqual(['sidebar.html']);

    // 4. Mixed document with both nav and footer rejected (ambiguous ownership)
    await fs.writeFile(
      path.join(f.root, 'mixed.html'),
      '<nav><a href="/">Home</a></nav><footer>Copyright</footer>'
    );
    s = await scan(f.root, f.store.root);
    cp = await f.store.commit(s.files, s.contents, 'save-mixed', { kind: 'unattributed' });
    await expect(staticSectionPaths(f.store, cp, 'mixed.html')).rejects.toThrow(
      'Ambiguous element ownership'
    );

    // 5. Section with inline script rejected
    await fs.writeFile(
      path.join(f.root, 'scripted.html'),
      '<section><script>console.log("bad")</script></section>'
    );
    s = await scan(f.root, f.store.root);
    cp = await f.store.commit(s.files, s.contents, 'save-scripted', { kind: 'unattributed' });
    await expect(staticSectionPaths(f.store, cp, 'scripted.html')).rejects.toThrow('ownership');

    // 6. CSS selector mismatch (nav selector in footer stylesheet) rejected
    await fs.writeFile(
      path.join(f.root, 'mismatch.html'),
      '<link rel="stylesheet" href="mismatch.css"><footer>Bad CSS</footer>'
    );
    await fs.writeFile(path.join(f.root, 'mismatch.css'), 'nav{color:red}');
    s = await scan(f.root, f.store.root);
    cp = await f.store.commit(s.files, s.contents, 'save-mismatch', { kind: 'unattributed' });
    await expect(staticSectionPaths(f.store, cp, 'mismatch.html')).rejects.toThrow(
      'Shared CSS selector blocked'
    );
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});

test('multi-element cherry-pick applies two independent elements (nav + footer) from different branches with Undo', async () => {
  const { applySelective } = await import('../../src/branches/apply');
  const f = await fixture();
  try {
    // Initial workspace: navbar.html, footer.html, index.html
    await fs.writeFile(path.join(f.root, 'navbar.html'), '<nav>Base Nav</nav>');
    await fs.writeFile(path.join(f.root, 'footer.html'), '<footer>Base Footer</footer>');
    await fs.writeFile(path.join(f.root, 'index.html'), '<main><h1>Base Main</h1></main>');
    let s = await scan(f.root, f.store.root);
    const base = await f.store.commit(s.files, s.contents, 'baseline', { kind: 'unattributed' });

    // Branch 1: update navbar.html and add navbar.css
    const b1 = await f.alternatives.fork(base, 'Nav-Branch');
    await fs.writeFile(
      path.join(b1.directory, 'navbar.html'),
      '<link rel="stylesheet" href="navbar.css"><nav><span class="brand">Branch 1 Nav</span></nav>'
    );
    await fs.writeFile(
      path.join(b1.directory, 'navbar.css'),
      'nav{display:flex}nav .brand{font-weight:bold}'
    );
    const selected1 = await f.alternatives.capture(b1.id);

    // Branch 2: update footer.html and add footer.css
    const b2 = await f.alternatives.fork(base, 'Footer-Branch');
    await fs.writeFile(
      path.join(b2.directory, 'footer.html'),
      '<link rel="stylesheet" href="footer.css"><footer><small class="meta">Branch 2 Footer</small></footer>'
    );
    await fs.writeFile(
      path.join(b2.directory, 'footer.css'),
      'footer{padding:10px}footer .meta{color:#666}'
    );
    const selected2 = await f.alternatives.capture(b2.id);

    // Workspace concurrently edits index.html (unrelated file)
    await fs.writeFile(
      path.join(f.root, 'index.html'),
      '<main><h1>Workspace Edited Main</h1></main>'
    );
    s = await scan(f.root, f.store.root);
    const current = await f.store.commit(s.files, s.contents, 'workspace-edit', {
      kind: 'unattributed'
    });

    // 1. Resolve files for both selections
    const selections = [
      { checkpoint: selected1, base, document: 'navbar.html', selector: 'nav' },
      { checkpoint: selected2, base, document: 'footer.html', selector: 'footer' }
    ];
    const resolved = await resolveElementFiles(f.store, selections);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].paths).toEqual(['navbar.html', 'navbar.css']);
    expect(resolved[1].paths).toEqual(['footer.html', 'footer.css']);

    // 2. Multi-element merge
    const items = resolved.map((r) => ({
      base: r.selection.base,
      selected: r.selection.checkpoint,
      paths: r.paths,
      selector: r.selection.selector
    }));
    const merged = mergeMultiElements(current, items);
    expect(merged.conflicts).toEqual([]);
    expect(merged.elements).toHaveLength(2);

    // 3. Review and apply selective
    const restore = new Restore(f.root, f.store, defaultLimits);
    const r = await restore.review(merged.target, current, false);
    expect(r.paths.sort()).toEqual(['footer.css', 'footer.html', 'navbar.css', 'navbar.html']);
    await applySelective(restore, merged.target, r.token, false, 'node -e "process.exit(0)"');

    // 4. Assert workspace state: navbar & footer updated, index.html preserved!
    expect(await fs.readFile(path.join(f.root, 'navbar.html'), 'utf8')).toContain(
      'Branch 1 Nav'
    );
    expect(await fs.readFile(path.join(f.root, 'navbar.css'), 'utf8')).toBe(
      'nav{display:flex}nav .brand{font-weight:bold}'
    );
    expect(await fs.readFile(path.join(f.root, 'footer.html'), 'utf8')).toContain(
      'Branch 2 Footer'
    );
    expect(await fs.readFile(path.join(f.root, 'footer.css'), 'utf8')).toBe(
      'footer{padding:10px}footer .meta{color:#666}'
    );
    expect(await fs.readFile(path.join(f.root, 'index.html'), 'utf8')).toBe(
      '<main><h1>Workspace Edited Main</h1></main>'
    );

    // 5. Undo restores all files
    await restore.undo(f.store.checkpoints.at(-1)!, false);
    expect(await fs.readFile(path.join(f.root, 'navbar.html'), 'utf8')).toBe(
      '<nav>Base Nav</nav>'
    );
    expect(await fs.readFile(path.join(f.root, 'footer.html'), 'utf8')).toBe(
      '<footer>Base Footer</footer>'
    );
    expect(await fs.readFile(path.join(f.root, 'index.html'), 'utf8')).toBe(
      '<main><h1>Workspace Edited Main</h1></main>'
    );
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});

test('overlapping file ownership across selections is rejected', async () => {
  const f = await fixture();
  try {
    const selections = [
      { checkpoint: f.base, base: f.base, document: 'navbar.html', selector: 'nav' },
      { checkpoint: f.base, base: f.base, document: 'navbar.html', selector: 'nav' }
    ];
    await expect(resolveElementFiles(f.store, selections)).rejects.toThrow(
      'Overlapping file ownership blocked'
    );
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});

test('one element fails static ownership -> entire multi-element batch rejected', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(
      path.join(f.root, 'bad.html'),
      '<section><script>alert("exploit")</script></section>'
    );
    const s = await scan(f.root, f.store.root);
    const cp = await f.store.commit(s.files, s.contents, 'save-bad', { kind: 'unattributed' });
    const selections = [
      { checkpoint: cp, base: f.base, document: 'navbar.html', selector: 'nav' },
      { checkpoint: cp, base: f.base, document: 'bad.html', selector: 'section' }
    ];
    await expect(resolveElementFiles(f.store, selections)).rejects.toThrow('ownership');
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});

test('three-way conflict on any element blocks multi-element merge', async () => {
  const f = await fixture();
  try {
    const b1 = await f.alternatives.fork(f.base, 'Nav');
    await fs.writeFile(path.join(b1.directory, 'navbar.html'), '<nav>Branch Nav</nav>');
    const selected1 = await f.alternatives.capture(b1.id);

    const b2 = await f.alternatives.fork(f.base, 'Footer');
    await fs.writeFile(path.join(b2.directory, 'footer.html'), '<footer>Branch Footer</footer>');
    const selected2 = await f.alternatives.capture(b2.id);

    // Workspace concurrently edits navbar.html (conflict with Branch 1)
    await fs.writeFile(path.join(f.root, 'navbar.html'), '<nav>Workspace Conflict Nav</nav>');
    const s = await scan(f.root, f.store.root);
    const current = await f.store.commit(s.files, s.contents, 'conflict', { kind: 'unattributed' });

    const items = [
      { base: f.base, selected: selected1, paths: ['navbar.html'], selector: 'nav' },
      { base: f.base, selected: selected2, paths: ['footer.html'], selector: 'footer' }
    ];
    const merged = mergeMultiElements(current, items);
    expect(merged.conflicts).toEqual(['navbar.html']);
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});

test('build/test failure on combined multi-element candidate triggers full rollback', async () => {
  const { applySelective } = await import('../../src/branches/apply');
  const f = await fixture();
  try {
    const b1 = await f.alternatives.fork(f.base, 'Nav');
    await fs.writeFile(path.join(b1.directory, 'navbar.html'), '<nav>New Nav</nav>');
    const selected1 = await f.alternatives.capture(b1.id);

    const b2 = await f.alternatives.fork(f.base, 'Footer');
    await fs.writeFile(path.join(b2.directory, 'footer.html'), '<footer>New Footer</footer>');
    const selected2 = await f.alternatives.capture(b2.id);

    const items = [
      { base: f.base, selected: selected1, paths: ['navbar.html'], selector: 'nav' },
      { base: f.base, selected: selected2, paths: ['footer.html'], selector: 'footer' }
    ];
    const merged = mergeMultiElements(f.base, items);
    expect(merged.conflicts).toEqual([]);

    const restore = new Restore(f.root, f.store, defaultLimits);
    const r = await restore.review(merged.target, f.base, false);

    // Failing build/test gate
    await expect(
      applySelective(restore, merged.target, r.token, false, 'node -e "process.exit(1)"')
    ).rejects.toThrow('failed');

    // Both files remain untouched in workspace
    expect(await fs.readFile(path.join(f.root, 'navbar.html'), 'utf8')).toBe('<nav>Old</nav>');
    expect(await fs.readFile(path.join(f.root, 'footer.html'), 'utf8')).toBe(
      '<footer>Original</footer>'
    );
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});

test('selective build/test pass, failure before writes, post-failure rollback and late drift', async () => {
  const { applySelective } = await import('../../src/branches/apply');
  const f = await fixture();
  try {
    const b = await f.alternatives.fork(f.base, 'Test');
    await fs.writeFile(path.join(b.directory, 'navbar.html'), '<nav>New</nav>');
    const selected = await f.alternatives.capture(b.id);
    const merged = mergeFiles(f.base, f.base, selected, ['navbar.html']);
    const restore = new Restore(f.root, f.store, defaultLimits);
    let r = await restore.review(merged.target, f.base, false);
    await expect(
      applySelective(restore, merged.target, r.token, false, 'node -e "process.exit(1)"')
    ).rejects.toThrow('failed');
    expect(await fs.readFile(path.join(f.root, 'navbar.html'), 'utf8')).toBe('<nav>Old</nav>');
    r = await restore.review(merged.target, f.base, false);
    const cmd = `node -e "process.exit(process.cwd().includes('validate')?0:1)"`;
    await expect(applySelective(restore, merged.target, r.token, false, cmd)).rejects.toThrow(
      'rolled back'
    );
    expect(await fs.readFile(path.join(f.root, 'navbar.html'), 'utf8')).toBe('<nav>Old</nav>');
    r = await restore.review(merged.target, f.store.checkpoints.at(-1)!, false);
    await applySelective(restore, merged.target, r.token, false, 'node -e "process.exit(0)"');
    expect(await fs.readFile(path.join(f.root, 'navbar.html'), 'utf8')).toBe('<nav>New</nav>');
    await restore.undo(f.store.checkpoints.at(-1)!, false);
    r = await restore.review(merged.target, f.store.checkpoints.at(-1)!, false);
    await fs.writeFile(path.join(f.root, 'navbar.html'), 'late');
    await expect(
      applySelective(restore, merged.target, r.token, false, 'node -e "process.exit(0)"')
    ).rejects.toThrow('Concurrent');
    expect(await fs.readFile(path.join(f.root, 'navbar.html'), 'utf8')).toBe('late');
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});
test('two real branch renders differ without workspace or sibling modification', async () => {
  const { PreviewRunner } = await import('../../src/preview/runner');
  const { chromium } = await import('playwright-core');
  const { createServer } = await import('node:net');
  const f = await fixture();
  const runners: InstanceType<typeof PreviewRunner>[] = [];
  try {
    await fs.writeFile(
      path.join(f.root, 'server.cjs'),
      `require('http').createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(require('fs').readFileSync('navbar.html'))}).listen(process.env.PORT,'127.0.0.1')`
    );
    const s = await scan(f.root, f.store.root);
    const base = await f.store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
    const b = await f.alternatives.fork(base, 'Rendered');
    await fs.writeFile(path.join(b.directory, 'navbar.html'), '<nav>New alternative</nav>');
    const other = await f.alternatives.capture(b.id);
    const images: string[] = [];
    for (const c of [base, other]) {
      const port = await new Promise<number>((resolve) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as { port: number }).port;
          server.close(() => resolve(port));
        });
      });
      const runner = new PreviewRunner(
        {
          command: 'node server.cjs',
          port,
          timeoutMs: 5000,
          browserPath: chromium.executablePath()
        },
        f.store
      );
      runners.push(runner);
      const result = await runner.historical(c, true);
      expect(result.screenshot).toBeDefined();
      images.push(result.screenshot!);
    }
    expect(await fs.readFile(images[0])).not.toEqual(await fs.readFile(images[1]));
    expect(await fs.readFile(path.join(f.root, 'navbar.html'), 'utf8')).toBe('<nav>Old</nav>');
    await fs.mkdir(path.resolve('../../docs/evidence'), { recursive: true });
    await fs.copyFile(images[0], path.resolve('../../docs/evidence/m4_workspace_render.png'));
    await fs.copyFile(images[1], path.resolve('../../docs/evidence/m4_alternative_render.png'));
  } finally {
    const directories = runners
      .map((r) => (r as unknown as { temp?: string }).temp)
      .filter((d): d is string => !!d);
    for (const r of runners) await r.stop();
    for (const directory of directories) await expect(fs.access(directory)).rejects.toThrow();
    // Repeated stop is safe and leaves no stale historical cwd.
    for (const r of runners) await r.stop();
    await fs.rm(f.temp, { recursive: true, force: true });
  }
}, 30000);
// Isolated temp-directory cleanup regression boundary.
