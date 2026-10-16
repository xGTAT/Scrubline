import type { Page } from 'playwright-core';
import type { BoundingBox, VisualCropDiff, VerificationOptions } from './types';

export interface CropArea {
  selector: string;
  region: 'target' | 'surrounding';
  tag?: string;
  box: BoundingBox;
}

/**
 * Compare two base64 PNG images using the browser's Canvas API.
 * Computes pixel diff ratio and generates a visual diff highlight.
 */
export async function compareCropsInBrowser(
  page: Page,
  imageADataUrl: string,
  imageBDataUrl: string,
  options: {
    colorTolerance?: number;
    highlightColor?: string;
    label?: string;
  } = {}
): Promise<{ diffRatio: number; diffHighlight?: string; diffCount: number; totalCount: number }> {
  return page.evaluate(
    async ({ imgA, imgB, colorTol, highlightColor, label }) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });

      const [a, b] = await Promise.all([load(imgA), load(imgB)]);
      const width = Math.max(a.width, b.width);
      const height = Math.max(a.height, b.height);

      if (width === 0 || height === 0) {
        return { diffRatio: 0, diffCount: 0, totalCount: 0 };
      }

      const canvasA = document.createElement('canvas');
      canvasA.width = width;
      canvasA.height = height;
      const ctxA = canvasA.getContext('2d')!;
      ctxA.drawImage(a, 0, 0);
      const dataA = ctxA.getImageData(0, 0, width, height).data;

      const canvasB = document.createElement('canvas');
      canvasB.width = width;
      canvasB.height = height;
      const ctxB = canvasB.getContext('2d')!;
      ctxB.drawImage(b, 0, 0);
      const dataB = ctxB.getImageData(0, 0, width, height).data;

      const diffCanvas = document.createElement('canvas');
      diffCanvas.width = width;
      diffCanvas.height = height;
      const diffCtx = diffCanvas.getContext('2d')!;

      // Draw baseline dimmed as background
      diffCtx.globalAlpha = 0.35;
      diffCtx.drawImage(a, 0, 0);
      diffCtx.globalAlpha = 1.0;

      const diffImage = diffCtx.getImageData(0, 0, width, height);
      const diffData = diffImage.data;

      let diffCount = 0;
      const totalPixels = width * height;
      const tol = colorTol ?? 30;

      let minX = width,
        minY = height,
        maxX = 0,
        maxY = 0;

      for (let i = 0; i < dataA.length; i += 4) {
        const dr = Math.abs(dataA[i] - dataB[i]);
        const dg = Math.abs(dataA[i + 1] - dataB[i + 1]);
        const db = Math.abs(dataA[i + 2] - dataB[i + 2]);
        const da = Math.abs(dataA[i + 3] - dataB[i + 3]);

        if (dr + dg + db + da > tol) {
          diffCount++;
          const pixelIdx = i / 4;
          const px = pixelIdx % width;
          const py = Math.floor(pixelIdx / width);

          minX = Math.min(minX, px);
          minY = Math.min(minY, py);
          maxX = Math.max(maxX, px);
          maxY = Math.max(maxY, py);

          // Highlight differing pixels (bright magenta)
          diffData[i] = 255;
          diffData[i + 1] = 0;
          diffData[i + 2] = 128;
          diffData[i + 3] = 255;
        }
      }

      diffCtx.putImageData(diffImage, 0, 0);

      // If diff detected, draw bounding highlight box and text
      if (diffCount > 0 && maxX >= minX && maxY >= minY) {
        diffCtx.strokeStyle = highlightColor || '#ff007f';
        diffCtx.lineWidth = 3;
        diffCtx.strokeRect(minX - 2, minY - 2, maxX - minX + 4, maxY - minY + 4);

        if (label) {
          diffCtx.fillStyle = '#ff007f';
          diffCtx.fillRect(minX, Math.max(0, minY - 20), 180, 18);
          diffCtx.fillStyle = '#ffffff';
          diffCtx.font = 'bold 11px sans-serif';
          diffCtx.fillText(label, minX + 4, Math.max(14, minY - 6));
        }
      }

      const diffRatio = diffCount / totalPixels;
      const diffHighlight = diffCanvas.toDataURL('image/png');

      return { diffRatio, diffHighlight, diffCount, totalCount: totalPixels };
    },
    {
      imgA: imageADataUrl,
      imgB: imageBDataUrl,
      colorTol: options.colorTolerance,
      highlightColor: options.highlightColor,
      label: options.label
    }
  );
}

/**
 * Pure TypeScript RGBA buffer comparator (offline / node-friendly).
 */
export function compareRgbaBuffers(
  bufA: Uint8Array,
  bufB: Uint8Array,
  width: number,
  height: number,
  colorTolerance = 30
): { diffRatio: number; diffCount: number; totalCount: number; isMatch: boolean } {
  const len = Math.min(bufA.length, bufB.length);
  const totalPixels = width * height || len / 4;
  let diffCount = 0;

  for (let i = 0; i < len; i += 4) {
    const dr = Math.abs(bufA[i] - bufB[i]);
    const dg = Math.abs(bufA[i + 1] - bufB[i + 1]);
    const db = Math.abs(bufA[i + 2] - bufB[i + 2]);
    const da = Math.abs(bufA[i + 3] - bufB[i + 3]);
    if (dr + dg + db + da > colorTolerance) {
      diffCount++;
    }
  }

  const diffRatio = totalPixels > 0 ? diffCount / totalPixels : 0;
  return {
    diffRatio,
    diffCount,
    totalCount: totalPixels,
    isMatch: diffRatio <= 0.05
  };
}

/**
 * Capture cropped screenshot of an element on a live page.
 */
export async function captureElementCrop(
  page: Page,
  selector: string,
  padding = 0
): Promise<{ dataUrl: string; box: BoundingBox } | undefined> {
  try {
    const rect = await page.locator(selector).first().boundingBox();
    if (!rect || rect.width <= 0 || rect.height <= 0) return undefined;

    const clip = {
      x: Math.max(0, rect.x - padding),
      y: Math.max(0, rect.y - padding),
      width: rect.width + padding * 2,
      height: rect.height + padding * 2
    };

    const buffer = await page.screenshot({ clip });
    const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;

    return {
      dataUrl,
      box: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  } catch {
    return undefined;
  }
}

/**
 * Run targeted visual comparison across target and surrounding invariant regions.
 */
export async function runTargetedVisualComparison(
  candidatePage: Page,
  historicalPage: Page,
  baselinePage: Page,
  targetSelector: string,
  invariantSelectors: string[],
  options: VerificationOptions = {}
): Promise<VisualCropDiff[]> {
  const diffs: VisualCropDiff[] = [];
  const visualThreshold = options.visualDiffThreshold ?? 0.05;
  const targetThreshold = options.targetDiffThreshold ?? 0.15;

  // 1. Verify Target Element matches historical appearance (Checkpoint A)
  const candidateTargetCrop = await captureElementCrop(candidatePage, targetSelector);
  const historicalTargetCrop = await captureElementCrop(historicalPage, targetSelector);

  if (candidateTargetCrop && historicalTargetCrop) {
    const targetComp = await compareCropsInBrowser(
      candidatePage,
      historicalTargetCrop.dataUrl,
      candidateTargetCrop.dataUrl,
      { label: `TARGET: ${targetSelector}` }
    );

    const passed = targetComp.diffRatio <= targetThreshold;
    diffs.push({
      region: 'target',
      selector: targetSelector,
      diffRatio: targetComp.diffRatio,
      threshold: targetThreshold,
      passed,
      boundingBox: candidateTargetCrop.box,
      diffHighlight: !passed ? targetComp.diffHighlight : undefined,
      message: passed
        ? `Target element matches historical checkpoint (diff: ${(targetComp.diffRatio * 100).toFixed(1)}%)`
        : `Target element appearance deviates from historical checkpoint (diff: ${(targetComp.diffRatio * 100).toFixed(1)}%)`
    });
  }

  // 2. Verify Surrounding Invariants match baseline appearance (Checkpoint B)
  for (const sel of invariantSelectors) {
    if (sel === targetSelector) continue;

    const candidateCrop = await captureElementCrop(candidatePage, sel);
    const baselineCrop = await captureElementCrop(baselinePage, sel);

    if (!baselineCrop) continue; // Invariant wasn't present in baseline

    if (!candidateCrop) {
      // Invariant element completely vanished in candidate!
      diffs.push({
        region: 'surrounding',
        selector: sel,
        diffRatio: 1.0,
        threshold: visualThreshold,
        passed: false,
        boundingBox: baselineCrop.box,
        diffHighlight: baselineCrop.dataUrl,
        message: `Surrounding invariant ${sel} unexpectedly vanished`
      });
      continue;
    }

    const comp = await compareCropsInBrowser(
      candidatePage,
      baselineCrop.dataUrl,
      candidateCrop.dataUrl,
      { label: `VANISHED / MUTATED: ${sel}` }
    );

    const passed = comp.diffRatio <= visualThreshold;
    diffs.push({
      region: 'surrounding',
      selector: sel,
      diffRatio: comp.diffRatio,
      threshold: visualThreshold,
      passed,
      boundingBox: candidateCrop.box,
      diffHighlight: !passed ? comp.diffHighlight : undefined,
      message: passed
        ? `Surrounding invariant ${sel} intact (diff: ${(comp.diffRatio * 100).toFixed(1)}%)`
        : `Surrounding invariant ${sel} unexpectedly mutated (diff: ${(comp.diffRatio * 100).toFixed(1)}%)`
    });
  }

  return diffs;
}
