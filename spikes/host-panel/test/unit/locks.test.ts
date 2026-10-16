import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LockRegistry } from '../../src/locks/registry';

test('lock registry adds, lists, replaces, removes and persists locks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-locks-'));
  try {
    const registry = new LockRegistry(root);
    await registry.open();
    expect(registry.list()).toEqual([]);

    await registry.add({ selector: '#buy-button', document: 'index.html', label: 'Buy button' });
    await registry.add({ selector: '.nav', document: 'index.html' });
    expect(registry.list().length).toBe(2);
    expect(registry.isLocked('#buy-button', 'index.html')).toBe(true);
    expect(registry.isLocked('#buy-button', 'other.html')).toBe(false);

    // Same selector+document replaces instead of duplicating.
    await registry.add({ selector: '#buy-button', document: 'index.html', label: 'Renamed' });
    expect(registry.list().length).toBe(2);
    expect(registry.list().find((l) => l.selector === '#buy-button')?.label).toBe('Renamed');

    // A second registry over the same store sees the persisted locks.
    const reloaded = new LockRegistry(root);
    await reloaded.open();
    expect(reloaded.list().length).toBe(2);

    expect(await reloaded.remove('.nav', 'index.html')).toBe(true);
    expect(await reloaded.remove('.nav', 'index.html')).toBe(false);
    expect(reloaded.list().length).toBe(1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('touchedBy flags locks whose owning document changed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-locks-'));
  try {
    const registry = new LockRegistry(root);
    await registry.open();
    await registry.add({ selector: '#buy-button', document: 'index.html' });
    await registry.add({ selector: '.hero', document: 'about.html' });
    expect(registry.touchedBy(['index.html']).map((l) => l.selector)).toEqual(['#buy-button']);
    expect(registry.touchedBy(['styles.css'])).toEqual([]);
    expect(registry.touchedBy(['index.html', 'about.html']).length).toBe(2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
