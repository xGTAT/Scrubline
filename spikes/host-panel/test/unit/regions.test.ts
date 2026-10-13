import { test, expect } from 'vitest';
import { regionChanges } from '../../src/webview/regions';
import type { Region } from '../../src/webview/Frame';
const region = (key: string, extra: Partial<Region> = {}): Region => ({
  key,
  signature: 'same',
  x: 10,
  y: 20,
  width: 40,
  height: 50,
  ...extra
});
test('region comparison covers movement, size-only change, appearance, additions and removals', () => {
  const before = ['move', 'resize', 'appearance', 'remove', 'stable'].map((id) => region(id));
  const after = [
    region('move', { x: 80 }),
    region('resize', { width: 90 }),
    region('appearance', { signature: 'new' }),
    region('add'),
    region('stable')
  ];
  expect(regionChanges(before, after).map((m) => [m.region.key, m.kind])).toEqual([
    ['move', 'moved'],
    ['resize', 'resized'],
    ['appearance', 'changed'],
    ['add', 'added'],
    ['remove', 'removed']
  ]);
});
test('subpixel movement stays below comparison tolerance and matching uses identity not order', () => {
  expect(
    regionChanges([region('a'), region('b')], [region('b'), region('a', { x: 10.5 })])
  ).toEqual([]);
});

test('focus review collapses nested changes without losing separate areas', async () => {
  const { focusedChanges } = await import('../../src/webview/regions');
  const changes = regionChanges(
    [],
    [
      region('parent', { x: 0, y: 0, width: 200, height: 200 }),
      region('child'),
      region('other', { x: 400 })
    ]
  );
  expect(focusedChanges(changes).map((c) => c.region.key)).toEqual(['parent', 'other']);
});
