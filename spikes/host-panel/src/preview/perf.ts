import { parse } from 'parse5';
import postcss from 'postcss';
import type { TrackedFile, PerfMetrics, PerfDelta } from '../bridge/timeline';

const HTML = new Set(['.html', '.htm']);
const CSS = new Set(['.css']);

const ext = (p: string) => {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i).toLowerCase() : '';
};

const countElements = (html: string): number => {
  let count = 0;
  const visit = (node: unknown) => {
    const n = node as { tagName?: string; childNodes?: unknown[] };
    if (n.tagName) count++;
    for (const c of n.childNodes ?? []) visit(c);
  };
  visit(parse(html));
  return count;
};

const countRules = (css: string): number => {
  let count = 0;
  postcss.parse(css).walkRules(() => {
    count++;
  });
  return count;
};

/**
 * Static performance metrics for one checkpoint, computed deterministically
 * from the committed bytes (no browser): DOM size, CSS weight and asset
 * bytes. Deterministic so the checkpoint id stays a pure function of content.
 */
export function computePerfMetrics(
  files: TrackedFile[],
  contents: Map<string, Buffer>
): PerfMetrics {
  let htmlBytes = 0;
  let domElements = 0;
  let cssBytes = 0;
  let cssRules = 0;
  let assetBytes = 0;
  for (const f of files) {
    const bytes = contents.get(f.path);
    const size = f.size;
    const extension = ext(f.path);
    if (HTML.has(extension)) {
      htmlBytes += size;
      if (bytes)
        try {
          domElements += countElements(bytes.toString('utf8'));
        } catch {
          // Malformed HTML still commits; the metric degrades to bytes only.
        }
    } else if (CSS.has(extension)) {
      cssBytes += size;
      if (bytes)
        try {
          cssRules += countRules(bytes.toString('utf8'));
        } catch {
          // Unparseable CSS still commits; the metric degrades to bytes only.
        }
    } else {
      assetBytes += size;
    }
  }
  return {
    htmlBytes,
    domElements,
    cssBytes,
    cssRules,
    assetBytes,
    totalBytes: htmlBytes + cssBytes + assetBytes
  };
}

const LABELS: Record<keyof PerfMetrics, string> = {
  htmlBytes: 'HTML',
  domElements: 'DOM elements',
  cssBytes: 'CSS',
  cssRules: 'CSS rules',
  assetBytes: 'Assets',
  totalBytes: 'Total'
};

/** Per-metric deltas from a parent checkpoint to a child; skips zero deltas. */
export function diffPerf(before?: PerfMetrics, after?: PerfMetrics): PerfDelta[] {
  if (!before || !after) return [];
  const deltas: PerfDelta[] = [];
  for (const metric of Object.keys(LABELS) as (keyof PerfMetrics)[]) {
    const delta = after[metric] - before[metric];
    if (delta !== 0)
      deltas.push({
        metric,
        label: LABELS[metric],
        before: before[metric],
        after: after[metric],
        delta
      });
  }
  return deltas;
}
