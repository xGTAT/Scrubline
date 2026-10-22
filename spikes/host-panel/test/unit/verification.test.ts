import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HistoryStore } from '../../src/store/store';
import { scan, defaultLimits } from '../../src/capture/scanner';
import { Restore } from '../../src/review/restore';
import { elementCandidate } from '../../src/branches/element';
import { applySelective } from '../../src/branches/apply';
import { DualVerificationEngine } from '../../src/verification/engine';
import {
  captureStructuralFingerprint,
  validateStructuralInvariants
} from '../../src/verification/structural';
import { compareRgbaBuffers } from '../../src/verification/visual';
import type { StructuralFingerprint } from '../../src/verification/types';

async function createFixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-verify-'));
  const root = path.join(temp, 'project');
  await fs.mkdir(root);
  const store = new HistoryStore(path.join(temp, 'history'));
  await store.open();

  const capture = async (html: string, css: string) => {
    await fs.writeFile(path.join(root, 'index.html'), html);
    await fs.writeFile(path.join(root, 'site.css'), css);
    const s = await scan(root, store.root);
    return store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });
  };

  return { temp, root, store, capture };
}

test('successful selective element restore where sibling elements remain intact', async () => {
  const f = await createFixture();
  try {
    const oldHtml = `
      <!DOCTYPE html>
      <html>
        <head><link rel="stylesheet" href="site.css"></head>
        <body>
          <header id="site-header"><h1>Site Header</h1></header>
          <nav id="site-nav"><a href="/">Home</a></nav>
          <main id="main-content">
            <section id="hero"><h2>Original Hero Content</h2></section>
            <aside id="sidebar"><p>Persistent Sidebar</p></aside>
          </main>
          <footer id="site-footer"><p>Company Footer</p></footer>
        </body>
      </html>
    `;
    const oldCss = `
      body { margin: 0; }
      #hero { color: red; padding: 10px; }
      #site-header { background: #333; }
      #site-nav { display: flex; }
      #sidebar { width: 200px; }
      #site-footer { border-top: 1px solid #ccc; }
    `;

    const nowHtml = `
      <!DOCTYPE html>
      <html>
        <head><link rel="stylesheet" href="site.css"></head>
        <body>
          <header id="site-header"><h1>Site Header</h1></header>
          <nav id="site-nav"><a href="/">Home</a></nav>
          <main id="main-content">
            <section id="hero"><h2>Current Mutated Hero</h2></section>
            <aside id="sidebar"><p>Persistent Sidebar</p></aside>
          </main>
          <footer id="site-footer"><p>Company Footer</p></footer>
        </body>
      </html>
    `;
    const nowCss = `
      body { margin: 0; }
      #hero { color: blue; padding: 30px; }
      #site-header { background: #333; }
      #site-nav { display: flex; }
      #sidebar { width: 200px; }
      #site-footer { border-top: 1px solid #ccc; }
    `;

    const oldCp = await f.capture(oldHtml, oldCss);
    const nowCp = await f.capture(nowHtml, nowCss);

    // Create selective candidate restoring #hero from oldCp to nowCp
    const candidate = await elementCandidate(f.store, oldCp, nowCp, 'index.html', 'hero');

    // 1. Run automated verification pass
    const report = await DualVerificationEngine.verifyStaticDocuments({
      store: f.store,
      current: nowCp,
      candidate,
      targetSelector: '#hero',
      documentPath: 'index.html'
    });

    expect(report.status).toBe('passed');
    expect(report.structuralViolations).toHaveLength(0);
    expect(report.summary).toContain('Verification passed');

    // 2. Perform selective apply with verification enabled
    const restore = new Restore(f.root, f.store, defaultLimits);
    const review = await restore.review(candidate, nowCp, false);

    const applied = await applySelective(
      restore,
      candidate,
      review.token,
      false,
      'node -e "process.exit(0)"',
      () => false,
      {
        verify: {
          historical: oldCp,
          current: nowCp,
          targetSelector: '#hero',
          documentPath: 'index.html'
        }
      }
    );

    expect(applied).toBeDefined();

    // Verify workspace restored #hero while keeping all invariants intact
    const restoredHtml = await fs.readFile(path.join(f.root, 'index.html'), 'utf8');
    const restoredCss = await fs.readFile(path.join(f.root, 'site.css'), 'utf8');

    expect(restoredHtml).toContain('<h2>Original Hero Content</h2>');
    expect(restoredHtml).toContain('<header id="site-header"><h1>Site Header</h1></header>');
    expect(restoredHtml).toContain('<nav id="site-nav"><a href="/">Home</a></nav>');
    expect(restoredHtml).toContain('<aside id="sidebar"><p>Persistent Sidebar</p></aside>');
    expect(restoredHtml).toContain('<footer id="site-footer"><p>Company Footer</p></footer>');
    expect(restoredCss).toContain('color: red');
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});

test('regressed restore where an unrelated header or sibling is pruned or hidden is rejected and flagged', async () => {
  const f = await createFixture();
  try {
    const baseHtml = `
      <!DOCTYPE html>
      <html>
        <head><link rel="stylesheet" href="site.css"></head>
        <body>
          <header id="site-header"><h1>Critical Navigation Header</h1></header>
          <nav id="site-nav">Nav Menu</nav>
          <main>
            <section id="hero">Current Hero</section>
            <aside id="sidebar">Sidebar</aside>
          </main>
          <footer>Footer</footer>
        </body>
      </html>
    `;
    const baseCss = `body { margin: 0; } #hero { color: blue; } header { display: block; }`;

    const nowCp = await f.capture(baseHtml, baseCss);

    // Simulate regressed candidate where an unrelated <header> was accidentally removed or hidden
    const regressedMissingHeaderHtml = `
      <!DOCTYPE html>
      <html>
        <head><link rel="stylesheet" href="site.css"></head>
        <body>
          <nav id="site-nav">Nav Menu</nav>
          <main>
            <section id="hero">Restored Hero</section>
            <aside id="sidebar">Sidebar</aside>
          </main>
          <footer>Footer</footer>
        </body>
      </html>
    `;

    await fs.writeFile(path.join(f.root, 'index.html'), regressedMissingHeaderHtml);
    const s = await scan(f.root, f.store.root);
    const regressedCp = await f.store.commit(s.files, s.contents, 'save', { kind: 'unattributed' });

    // Revert workspace back to intact state before apply attempt
    await fs.writeFile(path.join(f.root, 'index.html'), baseHtml);

    // Verification must flag the missing header
    const report = await DualVerificationEngine.verifyStaticDocuments({
      store: f.store,
      current: nowCp,
      candidate: regressedCp,
      targetSelector: '#hero',
      documentPath: 'index.html'
    });

    expect(report.status).toBe('failed');
    expect(report.failureReason).toContain('Invariant Violation');
    expect(report.failureReason).toMatch(/header/i);
    expect(
      report.structuralViolations.some((v) => v.tag === 'header' && v.kind === 'missing')
    ).toBe(true);

    // Applying this candidate must be rejected and prevent destructive update
    const restore = new Restore(f.root, f.store, defaultLimits);
    const review = await restore.review(regressedCp, nowCp, false);

    let errorThrown: Error | undefined;
    try {
      await applySelective(
        restore,
        regressedCp,
        review.token,
        false,
        'node -e "process.exit(0)"',
        () => false,
        {
          verify: {
            current: nowCp,
            targetSelector: '#hero',
            documentPath: 'index.html'
          }
        }
      );
    } catch (err) {
      errorThrown = err;
    }

    expect(errorThrown).toBeDefined();
    expect(errorThrown.message).toContain('Invariant Violation');
    expect(errorThrown.verificationReport).toBeDefined();
    expect(errorThrown.verificationReport.status).toBe('failed');

    // Confirm that workspace sources were NOT mutated or destructively overwritten
    const currentWorkspaceHtml = await fs.readFile(path.join(f.root, 'index.html'), 'utf8');
    expect(currentWorkspaceHtml).toContain('Critical Navigation Header');

    // Test hidden sibling invariant (e.g. style="display: none")
    const regressedHiddenHeaderHtml = `
      <!DOCTYPE html>
      <html>
        <head><link rel="stylesheet" href="site.css"></head>
        <body>
          <header id="site-header" style="display: none"><h1>Critical Navigation Header</h1></header>
          <nav id="site-nav">Nav Menu</nav>
          <main><section id="hero">Restored Hero</section></main>
          <footer>Footer</footer>
        </body>
      </html>
    `;
    await fs.writeFile(path.join(f.root, 'index.html'), regressedHiddenHeaderHtml);
    const s2 = await scan(f.root, f.store.root);
    const hiddenCp = await f.store.commit(s2.files, s2.contents, 'save', { kind: 'unattributed' });

    const hiddenReport = await DualVerificationEngine.verifyStaticDocuments({
      store: f.store,
      current: nowCp,
      candidate: hiddenCp,
      targetSelector: '#hero',
      documentPath: 'index.html'
    });

    expect(hiddenReport.status).toBe('failed');
    expect(hiddenReport.failureReason).toContain('Invariant Violation');
    expect(hiddenReport.structuralViolations.some((v) => v.kind === 'hidden')).toBe(true);
  } finally {
    await fs.rm(f.temp, { recursive: true, force: true });
  }
});

test('structural invariant validator catches missing, hidden, collapsed and shifted nodes', () => {
  const baseline: StructuralFingerprint = {
    timestamp: new Date().toISOString(),
    targetSelector: '#target',
    nodes: [
      {
        selector: '#header',
        tag: 'header',
        id: 'header',
        isTarget: false,
        isSibling: false,
        box: { x: 0, y: 0, width: 800, height: 60 },
        styles: { display: 'block', visibility: 'visible', opacity: 1 },
        present: true
      },
      {
        selector: 'nav',
        tag: 'nav',
        isTarget: false,
        isSibling: false,
        box: { x: 0, y: 60, width: 800, height: 40 },
        styles: { display: 'flex', visibility: 'visible', opacity: 1 },
        present: true
      },
      {
        selector: '#sidebar',
        tag: 'aside',
        id: 'sidebar',
        isTarget: false,
        isSibling: true,
        box: { x: 600, y: 100, width: 200, height: 400 },
        styles: { display: 'block', visibility: 'visible', opacity: 1 },
        present: true
      },
      {
        selector: '#target',
        tag: 'div',
        id: 'target',
        isTarget: true,
        isSibling: false,
        box: { x: 0, y: 100, width: 600, height: 400 },
        styles: { display: 'block', visibility: 'visible', opacity: 1 },
        present: true
      }
    ]
  };

  // 1. Missing node case
  const candidateMissingNav: StructuralFingerprint = {
    timestamp: new Date().toISOString(),
    targetSelector: '#target',
    nodes: baseline.nodes.filter((n) => n.tag !== 'nav')
  };
  const v1 = validateStructuralInvariants(baseline, candidateMissingNav);
  expect(v1.some((v) => v.tag === 'nav' && v.kind === 'missing')).toBe(true);
  expect(v1[0].message).toBe('Invariant Violation: <nav> removed');

  // 2. Hidden node case (display: none)
  const candidateHiddenHeader: StructuralFingerprint = {
    timestamp: new Date().toISOString(),
    targetSelector: '#target',
    nodes: baseline.nodes.map((n) =>
      n.id === 'header'
        ? { ...n, styles: { display: 'none', visibility: 'hidden', opacity: 0 } }
        : n
    )
  };
  const v2 = validateStructuralInvariants(baseline, candidateHiddenHeader);
  expect(v2.some((v) => v.tag === 'header' && v.kind === 'hidden')).toBe(true);

  // 3. Collapsed bounding box (width = 0, height = 0)
  const candidateCollapsedSidebar: StructuralFingerprint = {
    timestamp: new Date().toISOString(),
    targetSelector: '#target',
    nodes: baseline.nodes.map((n) =>
      n.id === 'sidebar' ? { ...n, box: { x: 600, y: 100, width: 0, height: 0 } } : n
    )
  };
  const v3 = validateStructuralInvariants(baseline, candidateCollapsedSidebar);
  expect(v3.some((v) => v.id === 'sidebar' || (v.tag === 'aside' && v.kind === 'collapsed'))).toBe(
    true
  );

  // 4. Excessive bounding box shift
  const candidateShiftedSidebar: StructuralFingerprint = {
    timestamp: new Date().toISOString(),
    targetSelector: '#target',
    nodes: baseline.nodes.map((n) =>
      n.id === 'sidebar' ? { ...n, box: { x: 950, y: 400, width: 200, height: 400 } } : n
    )
  };
  const v4 = validateStructuralInvariants(baseline, candidateShiftedSidebar, { tolerancePx: 10 });
  expect(v4.some((v) => v.tag === 'aside' && v.kind === 'shifted')).toBe(true);
});

test('perceptual / pixel diff accurately measures difference and detects regressions', () => {
  const width = 10;
  const height = 10;
  const total = width * height * 4;

  // Image A: all white (255, 255, 255, 255)
  const imgA = new Uint8Array(total);
  imgA.fill(255);

  // Image B: exact match
  const imgB = new Uint8Array(total);
  imgB.fill(255);

  const matchRes = compareRgbaBuffers(imgA, imgB, width, height);
  expect(matchRes.diffCount).toBe(0);
  expect(matchRes.diffRatio).toBe(0);
  expect(matchRes.isMatch).toBe(true);

  // Image C: 20% of pixels changed to black
  const imgC = new Uint8Array(total);
  imgC.fill(255);
  for (let i = 0; i < 20 * 4; i += 4) {
    imgC[i] = 0;
    imgC[i + 1] = 0;
    imgC[i + 2] = 0;
  }

  const diffRes = compareRgbaBuffers(imgA, imgC, width, height);
  expect(diffRes.diffCount).toBe(20);
  expect(diffRes.diffRatio).toBe(0.2);
  expect(diffRes.isMatch).toBe(false);
});

test('live targeted visual comparison detects mutated elements and generates diff highlights', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  try {
    const baselinePage = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const historicalPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const candidatePage = await browser.newPage({ viewport: { width: 800, height: 600 } });

    // Baseline: Current state (black header, white text; blue target)
    await baselinePage.setContent(`
      <!DOCTYPE html>
      <html><body>
        <header id="main-header" style="height:50px;background:#111;color:#fff;padding:10px;">Header</header>
        <div id="target" style="height:100px;background:#0000ff;padding:10px;">Target Original</div>
        <footer id="main-footer" style="height:40px;background:#222;color:#fff;padding:10px;">Footer</footer>
      </body></html>
    `);

    // Historical: Old state (target was green)
    await historicalPage.setContent(`
      <!DOCTYPE html>
      <html><body>
        <header id="main-header" style="height:50px;background:#111;color:#fff;padding:10px;">Header</header>
        <div id="target" style="height:100px;background:#00ff00;padding:10px;">Target Historical</div>
        <footer id="main-footer" style="height:40px;background:#222;color:#fff;padding:10px;">Footer</footer>
      </body></html>
    `);

    // Regressed Candidate: Target was restored to green, but header was accidentally mutated / destroyed (e.g. turned bright pink or removed)
    await candidatePage.setContent(`
      <!DOCTYPE html>
      <html><body>
        <header id="main-header" style="height:50px;background:#ff007f;color:#fff;padding:10px;">Mutated Header</header>
        <div id="target" style="height:100px;background:#00ff00;padding:10px;">Target Historical</div>
        <footer id="main-footer" style="height:40px;background:#222;color:#fff;padding:10px;">Footer</footer>
      </body></html>
    `);

    const regressedReport = await DualVerificationEngine.verifyPages({
      candidatePage,
      historicalPage,
      baselinePage,
      targetSelector: '#target',
      options: { visualDiffThreshold: 0.05, targetDiffThreshold: 0.15 }
    });

    expect(regressedReport.status).toBe('failed');
    expect(
      regressedReport.visualDiffs.some((d) => d.selector === '#main-header' && !d.passed)
    ).toBe(true);
    expect(regressedReport.diffHighlights).toBeDefined();
    expect(regressedReport.diffHighlights!.length).toBeGreaterThan(0);
    expect(regressedReport.diffHighlights![0]).toContain('data:image/png;base64,');

    // Clean Candidate: Target restored to green, and header/footer are intact
    await candidatePage.setContent(`
      <!DOCTYPE html>
      <html><body>
        <header id="main-header" style="height:50px;background:#111;color:#fff;padding:10px;">Header</header>
        <div id="target" style="height:100px;background:#00ff00;padding:10px;">Target Historical</div>
        <footer id="main-footer" style="height:40px;background:#222;color:#fff;padding:10px;">Footer</footer>
      </body></html>
    `);

    const cleanReport = await DualVerificationEngine.verifyPages({
      candidatePage,
      historicalPage,
      baselinePage,
      targetSelector: '#target',
      options: { visualDiffThreshold: 0.05, targetDiffThreshold: 0.15 }
    });

    expect(cleanReport.status).toBe('passed');
    expect(cleanReport.structuralViolations).toHaveLength(0);
    expect(cleanReport.visualDiffs.every((d) => d.passed)).toBe(true);
  } finally {
    await browser.close();
  }
}, 25000);

test('live protect-all verification ignores non-rendered head, title and html nodes', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  try {
    const page = async (label: string) => {
      const p = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await p.setContent(`<!DOCTYPE html>
        <html><head><title>Site</title></head><body>
          <nav><a id="nav-link" href="/b">${label}</a></nav>
          <main><p>Body copy</p></main>
        </body></html>`);
      return p;
    };
    const baselinePage = await page('Reserve');
    const candidatePage = await page('Book now');
    const report = await DualVerificationEngine.verifyPages({
      candidatePage,
      baselinePage,
      targetSelector: '#nav-link',
      options: { protectAllElements: true, captureVisualDiffs: false }
    });
    const tags = report.structuralViolations.map((v) => v.tag);
    expect(tags).not.toContain('head');
    expect(tags).not.toContain('title');
    expect(tags).not.toContain('html');
    expect(report.status).toBe('passed');
  } finally {
    await browser.close();
  }
}, 25000);

test('live fingerprint selectors are unique for same-shaped elements in different containers', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`<!DOCTYPE html><html><body>
      <div class="a"><section><a href="/1">One</a><a href="/2">Two</a></section></div>
      <div class="b"><section><a href="/3">Three</a><a href="/4">Four</a></section></div>
    </body></html>`);
    const fp = await captureStructuralFingerprint(page, undefined, [], true);
    const anchors = fp.nodes.filter((n) => n.tag === 'a');
    expect(anchors).toHaveLength(4);
    expect(new Set(anchors.map((n) => n.selector)).size).toBe(4);
  } finally {
    await browser.close();
  }
}, 25000);

test('live visual verification does not flag a container that holds the changed target', async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
  try {
    const make = async (label: string) => {
      const p = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await p.setContent(`<!DOCTYPE html><html><body>
        <nav id="top-nav" style="padding:10px;background:#eee"><a id="t" href="/b" style="display:inline-block;width:120px">${label}</a></nav>
        <main style="padding:10px"><p>Body copy</p></main>
      </body></html>`);
      return p;
    };
    const baselinePage = await make('Reserve');
    const historicalPage = await make('Booking');
    const candidatePage = await make('Booking');
    const report = await DualVerificationEngine.verifyPages({
      candidatePage,
      historicalPage,
      baselinePage,
      targetSelector: '#t',
      options: { protectAllElements: true }
    });
    expect(report.visualDiffs.some((d) => d.selector === '#top-nav')).toBe(false);
    expect(report.status).toBe('passed');
  } finally {
    await browser.close();
  }
}, 25000);
