import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Checkpoint } from '../bridge/timeline';
import type { HistoryStore } from '../store/store';
import { PreviewRunner, type PreviewConfig } from '../preview/runner';
import type { Page } from 'playwright-core';
import type { VerificationReport, VerificationOptions, VisualCropDiff } from './types';
import {
  captureStructuralFingerprint,
  validateStructuralInvariants,
  captureStructuralFingerprintFromHtml
} from './structural';
import { runTargetedVisualComparison } from './visual';

export interface VerifyStagedParams {
  store: HistoryStore;
  previewConfig: PreviewConfig;
  historical: Checkpoint;
  current: Checkpoint;
  candidate: Checkpoint;
  targetSelector: string;
  documentPath?: string;
  options?: VerificationOptions;
  cancelled?: () => boolean;
}

export class DualVerificationEngine {
  /**
   * Run verification on live Playwright pages.
   */
  static async verifyPages(params: {
    candidatePage: Page;
    historicalPage?: Page;
    baselinePage: Page;
    targetSelector: string;
    options?: VerificationOptions;
  }): Promise<VerificationReport> {
    const { candidatePage, historicalPage, baselinePage, targetSelector, options = {} } = params;

    // Step 1 & 3: Structural Invariant Verification
    const baselineFingerprint = await captureStructuralFingerprint(
      baselinePage,
      targetSelector,
      [],
      options.protectAllElements
    );
    const candidateFingerprint = await captureStructuralFingerprint(
      candidatePage,
      targetSelector,
      [],
      options.protectAllElements
    );

    const structuralViolations = validateStructuralInvariants(
      baselineFingerprint,
      candidateFingerprint,
      options
    );

    // Step 1 & 3: Targeted Visual Comparison
    let visualDiffs: VisualCropDiff[] = [];
    const invariantSelectors = baselineFingerprint.nodes
      .filter(
        (n) =>
          !n.isTarget &&
          (n.isSibling || ['header', 'nav', 'main', 'footer', 'aside'].includes(n.tag))
      )
      .map((n) => n.selector);

    if (options.captureVisualDiffs !== false && historicalPage) {
      visualDiffs = await runTargetedVisualComparison(
        candidatePage,
        historicalPage,
        baselinePage,
        targetSelector,
        invariantSelectors,
        options
      );
    }

    const visualViolations = visualDiffs.filter((d) => !d.passed);
    const passed = structuralViolations.length === 0 && visualViolations.length === 0;

    let failureReason: string | undefined;
    if (!passed) {
      if (structuralViolations.length > 0) {
        failureReason = structuralViolations[0].message;
      } else if (visualViolations.length > 0) {
        failureReason = visualViolations[0].message;
      }
    }

    const diffHighlights = visualDiffs
      .filter((d) => !d.passed && d.diffHighlight)
      .map((d) => d.diffHighlight!);

    const summary = passed
      ? `Verification passed: 0 structural violations, target appearance matched, invariants preserved.`
      : `Verification failed: ${structuralViolations.length} structural violation(s), ${visualViolations.length} visual regression(s). ${failureReason || ''}`.trim();

    return {
      status: passed ? 'passed' : 'failed',
      targetSelector,
      structuralViolations,
      visualDiffs,
      failureReason,
      summary,
      diffHighlights,
      verifiedAt: new Date().toISOString()
    };
  }

  /**
   * Run full staged mutation and multi-checkpoint output verification in isolated sandbox.
   */
  static async verifyStagedCheckpoint(params: VerifyStagedParams): Promise<VerificationReport> {
    const {
      store,
      previewConfig,
      historical,
      current,
      candidate,
      targetSelector,
      options = {},
      cancelled = () => false
    } = params;

    if (cancelled()) {
      throw new Error('Verification cancelled.');
    }

    // Offline / Document fallback if no browser or preview command configured
    if (!previewConfig.command || !previewConfig.browserPath) {
      return DualVerificationEngine.verifyStaticDocuments({
        store,
        current,
        candidate,
        targetSelector,
        documentPath: params.documentPath || 'index.html',
        options
      });
    }

    const { chromium } = await import('playwright-core');
    const tempDir = path.join(store.root, 'verify-staged', randomUUID());
    await store.materialize(candidate, tempDir);

    const candidateRunner = new PreviewRunner(
      { ...previewConfig, port: previewConfig.port + 11 },
      store
    );
    const baselineRunner = new PreviewRunner(
      { ...previewConfig, port: previewConfig.port + 12 },
      store
    );
    const historicalRunner = new PreviewRunner(
      { ...previewConfig, port: previewConfig.port + 13 },
      store
    );

    let browser;
    try {
      const [candOrigin, baseOrigin, histOrigin] = await Promise.all([
        candidateRunner.start(tempDir, true),
        baselineRunner.historical(current, true, 'verify-snapshots').then((r) => r.url!),
        historicalRunner.historical(historical, true, 'verify-snapshots').then((r) => r.url!)
      ]);

      if (cancelled()) throw new Error('Verification cancelled.');

      browser = await chromium.launch({
        executablePath: previewConfig.browserPath,
        headless: true,
        args: ['--disable-gpu']
      });

      const route = previewConfig.route || '/';
      const candPage = await browser.newPage({
        viewport: { width: previewConfig.width || 960, height: previewConfig.height || 600 }
      });
      const basePage = await browser.newPage({
        viewport: { width: previewConfig.width || 960, height: previewConfig.height || 600 }
      });
      const histPage = await browser.newPage({
        viewport: { width: previewConfig.width || 960, height: previewConfig.height || 600 }
      });

      await Promise.all([
        candPage.goto(new URL(route, candOrigin).toString(), { waitUntil: 'networkidle' }),
        basePage.goto(new URL(route, baseOrigin).toString(), { waitUntil: 'networkidle' }),
        histPage.goto(new URL(route, histOrigin).toString(), { waitUntil: 'networkidle' })
      ]);

      return await DualVerificationEngine.verifyPages({
        candidatePage: candPage,
        baselinePage: basePage,
        historicalPage: histPage,
        targetSelector,
        options
      });
    } finally {
      await browser?.close();
      await Promise.all([candidateRunner.stop(), baselineRunner.stop(), historicalRunner.stop()]);
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      await fs
        .rm(path.join(store.root, 'verify-snapshots'), { recursive: true, force: true })
        .catch(() => {});
    }
  }

  /**
   * Fast static document structural verification using HTML AST analysis.
   */
  static async verifyStaticDocuments(params: {
    store: HistoryStore;
    current: Checkpoint;
    candidate: Checkpoint;
    targetSelector: string;
    documentPath: string;
    options?: VerificationOptions;
  }): Promise<VerificationReport> {
    const { store, current, candidate, targetSelector, documentPath, options = {} } = params;

    const read = async (cp: Checkpoint, p: string) => {
      const f = cp.files.find((file) => file.path === p);
      if (!f) return '';
      return (await store.readBlob(f.hash)).toString('utf8');
    };

    const baseHtml = await read(current, documentPath);
    const candHtml = await read(candidate, documentPath);

    const baseFingerprint = captureStructuralFingerprintFromHtml(baseHtml, targetSelector);
    const candFingerprint = captureStructuralFingerprintFromHtml(candHtml, targetSelector);

    const structuralViolations = validateStructuralInvariants(
      baseFingerprint,
      candFingerprint,
      options
    );

    const passed = structuralViolations.length === 0;
    const failureReason = !passed ? structuralViolations[0].message : undefined;

    return {
      status: passed ? 'passed' : 'failed',
      targetSelector,
      structuralViolations,
      visualDiffs: [],
      failureReason,
      summary: passed
        ? 'Verification passed: All structural invariants preserved.'
        : `Verification failed: ${structuralViolations.length} structural violation(s). ${failureReason || ''}`.trim(),
      verifiedAt: new Date().toISOString()
    };
  }
}
