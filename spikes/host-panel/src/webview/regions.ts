import type { Region } from './Frame';
export type RegionChange = {
  region: Region;
  kind: 'moved' | 'resized' | 'changed' | 'added' | 'removed';
  old?: Region;
};
export function regionChanges(before: Region[], after: Region[]): RegionChange[] {
  const old = new Map(before.map((r) => [r.key, r]));
  const current = new Map(after.map((r) => [r.key, r]));
  const result: RegionChange[] = [];
  for (const r of after) {
    const previous = old.get(r.key);
    if (!previous) result.push({ region: r, kind: 'added' });
    else if (Math.abs(previous.x - r.x) > 1 || Math.abs(previous.y - r.y) > 1)
      result.push({ region: r, kind: 'moved', old: previous });
    else if (Math.abs(previous.width - r.width) > 1 || Math.abs(previous.height - r.height) > 1)
      result.push({ region: r, kind: 'resized', old: previous });
    else if (previous.signature !== r.signature)
      result.push({ region: r, kind: 'changed', old: previous });
  }
  for (const r of before) if (!current.has(r.key)) result.push({ region: r, kind: 'removed' });
  return result;
}

/** Prefer substantial, separate changes over nested marks of the same visual area. */
export function focusedChanges(changes: RegionChange[]): RegionChange[] {
  const area = (r: Region) => r.width * r.height;
  const ranked = [...changes].sort((a, b) => area(b.region) - area(a.region));
  const distinct: RegionChange[] = [];
  for (const change of ranked) {
    const r = change.region;
    if (
      distinct.some(
        ({ region: p }) =>
          r.x >= p.x &&
          r.y >= p.y &&
          r.x + r.width <= p.x + p.width &&
          r.y + r.height <= p.y + p.height
      )
    )
      continue;
    distinct.push(change);
  }
  return distinct;
}
