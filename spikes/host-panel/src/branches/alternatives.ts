import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { HistoryStore, hashBytes, safePath } from '../store/store';
import { scan, changedPaths, type ScanLimits } from '../capture/scanner';
import type { Checkpoint } from '../bridge/timeline';
export class Alternatives {
  constructor(
    readonly store: HistoryStore,
    readonly limits: ScanLimits
  ) {}
  list() {
    const branches = new Map<string, Checkpoint[]>();
    for (const c of this.store.checkpoints) {
      if (c.branch) {
        const chain = branches.get(c.branch.id) ?? [];
        chain.push(c);
        branches.set(c.branch.id, chain);
      }
    }
    return [...branches].map(([id, chain]) => {
      const first = chain.find((c) => !chain.some((p) => p.id === c.parentId))!;
      const head = chain.find((c) => !chain.some((p) => p.parentId === c.id))!;
      return {
        id,
        name: head.branch!.name,
        checkpoint: head.id,
        base: first.parentId!,
        directory: path.join(this.store.root, 'alternatives', id)
      };
    });
  }
  async fork(base: Checkpoint, name: string) {
    if (!this.store.checkpoints.some((c) => c.id === base.id)) throw new Error('Unknown base.');
    if (!name.trim() || name.length > 60) throw new Error('Choose a short branch name.');
    const id = randomUUID();
    const directory = path.join(this.store.root, 'alternatives', id);
    await this.store.materialize(base, directory);
    const captured = await scan(directory, this.store.root, this.limits);
    try {
      await this.store.commit(
        captured.files,
        captured.contents,
        'reconcile',
        { kind: 'unattributed' },
        { parentId: base.id, branch: { id, name: name.trim() } }
      );
    } catch (e) {
      await fs.rm(directory, { recursive: true, force: true });
      throw e;
    }
    return this.list().find((b) => b.id === id)!;
  }
  async capture(id: string) {
    const b = this.list().find((b) => b.id === id);
    if (!b) throw new Error('Unknown branch.');
    const head = this.store.checkpoints.find((c) => c.id === b.checkpoint)!;
    const one = await scan(b.directory, this.store.root, this.limits);
    const two = await scan(b.directory, this.store.root, this.limits);
    if (changedPaths(one.files, two.files).length)
      throw new Error('Branch changed during capture. Retry.');
    if (!changedPaths(head.files, two.files).length) return head;
    return this.store.commit(
      two.files,
      two.contents,
      'save',
      { kind: 'unattributed' },
      { parentId: head.id, branch: head.branch! }
    );
  }
  base(selected: Checkpoint) {
    const b = this.list().find((b) => b.id === selected.branch?.id);
    if (!b) throw new Error('Select an alternative checkpoint.');
    return this.store.checkpoints.find((c) => c.id === b.base)!;
  }
}
export function mergeFiles(
  base: Checkpoint,
  current: Checkpoint,
  selected: Checkpoint,
  paths: readonly string[]
): { target: Checkpoint; conflicts: string[] } {
  if (!paths.length || new Set(paths).size !== paths.length || paths.some((p) => !safePath(p)))
    throw new Error('Choose exact file paths.');
  const files = new Map(current.files.map((f) => [f.path, f]));
  const conflicts: string[] = [];
  for (const p of paths) {
    const b = base.files.find((f) => f.path === p),
      c = files.get(p),
      s = selected.files.find((f) => f.path === p);
    const same = (a: typeof b, other: typeof b) =>
      a?.hash === other?.hash && a?.mode === other?.mode;
    if (same(b, s) || same(c, s)) continue;
    if (!same(b, c)) {
      conflicts.push(p);
      continue;
    }
    if (s) files.set(p, s);
    else files.delete(p);
  }
  const body: Omit<Checkpoint, 'id'> = {
    schemaVersion: 1,
    parentId: current.id,
    createdAt: new Date().toISOString(),
    trigger: 'reconcile',
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    attribution: { kind: 'unattributed' }
  };
  return { target: { id: hashBytes(JSON.stringify(body)), ...body }, conflicts };
}
