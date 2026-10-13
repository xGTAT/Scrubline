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
