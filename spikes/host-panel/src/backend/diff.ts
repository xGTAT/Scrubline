import type { BackendCapture, BackendDiffEntry } from './types';

const key = (e: { method: string; host: string; path: string }) => `${e.method} ${e.host}${e.path}`;

/**
 * Compares two metadata captures by endpoint key. Both are samples of a live
 * backend: a difference shows the renders observed different traffic, never
 * why the server behaved differently.
 */
export function diffCaptures(before: BackendCapture, after: BackendCapture): BackendDiffEntry[] {
  const index = new Map<string, { status: number | null; durationMs: number | null }>();
  for (const entry of before.entries)
    index.set(key(entry), { status: entry.status, durationMs: entry.durationMs });
  const seen = new Set<string>();
  const diff: BackendDiffEntry[] = [];
  for (const entry of after.entries) {
    const k = key(entry);
    seen.add(k);
    const prior = index.get(k);
    if (!prior) {
      diff.push({ key: k, kind: 'added', after: String(entry.status ?? 'failed') });
      continue;
    }
    if (prior.status !== entry.status)
      diff.push({
        key: k,
        kind: 'status',
        before: String(prior.status ?? 'failed'),
        after: String(entry.status ?? 'failed')
      });
    else if (
      prior.durationMs != null &&
      entry.durationMs != null &&
      entry.durationMs > 50 &&
      entry.durationMs > prior.durationMs * 2
    )
      diff.push({
        key: k,
        kind: 'timing',
        before: `${prior.durationMs}ms`,
        after: `${entry.durationMs}ms`
      });
  }
  for (const entry of before.entries) {
    const k = key(entry);
    if (!seen.has(k))
      diff.push({ key: k, kind: 'removed', before: String(entry.status ?? 'failed') });
  }
  return diff;
}
