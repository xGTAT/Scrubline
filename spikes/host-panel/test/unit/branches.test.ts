import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HistoryStore } from '../../src/store/store';
import { scan, defaultLimits } from '../../src/capture/scanner';
import { Alternatives, mergeFiles } from '../../src/branches/alternatives';
import { Restore } from '../../src/review/restore';
import { staticNavbarPaths } from '../../src/branches/static-mapping';
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
    const previewRoot = path.join(f.store.root, 'previews');
    for (const r of runners) await r.stop();
    expect(await fs.readdir(previewRoot)).toEqual([]);
    // Repeated stop is safe and leaves no stale historical cwd.
    for (const r of runners) await r.stop();
    await fs.rm(f.temp, { recursive: true, force: true });
  }
}, 15000);
