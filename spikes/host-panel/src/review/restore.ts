import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryStore, atomicWrite, hashBytes, safePath } from '../store/store';
import { changedPaths, scan, type ScanLimits } from '../capture/scanner';
import type { Checkpoint, TrackedFile } from '../bridge/timeline';
export interface Review {
  token: string;
  checkpoint: string;
  current: TrackedFile[];
  paths: string[];
  conflicts: string[];
}
interface JournalEntry {
  path: string;
  before: TrackedFile | null;
  after: TrackedFile | null;
  moved: boolean;
  written: boolean;
  writeIntent: boolean;
}
interface Journal {
  schemaVersion: 1;
  phase: 'applying' | 'committed';
  root: string;
  safety: string;
  entries: JournalEntry[];
}
export class Restore {
  private pending?: Review;
  private undoCheckpoint?: Checkpoint;
  private undoExpected?: Checkpoint;
  constructor(
    readonly workspace: string,
    readonly store: HistoryStore,
    readonly limits: ScanLimits
  ) {}
  async review(target: Checkpoint, observed: Checkpoint, unsaved: boolean): Promise<Review> {
    if (unsaved) throw new Error('Save or discard unsaved changes first.');
    const current = await scan(this.workspace, this.store.root, this.limits);
    const drift = changedPaths(observed.files, current.files);
    const paths = changedPaths(current.files, target.files);
    this.pending = {
      token: randomUUID(),
      checkpoint: target.id,
      current: current.files,
      paths,
      conflicts: drift
    };
    return this.pending;
  }
  async apply(
    token: string,
    target: Checkpoint,
    unsaved: boolean,
    beforeWrite?: () => Promise<void>
  ): Promise<Checkpoint> {
    const review = this.pending;
    this.pending = undefined;
    if (!review || review.token !== token || review.checkpoint !== target.id)
      throw new Error('Review expired. Review again.');
    if (unsaved) throw new Error('Save or discard unsaved changes first.');
    if (review.conflicts.length)
      throw new Error('Workspace drift. Review three-way conflicts first.');
    const current = await scan(this.workspace, this.store.root, this.limits);
    if (changedPaths(review.current, current.files).length)
      throw new Error('Concurrent edit. Nothing restored.');
    if (!review.paths.length) throw new Error('No changes to restore.');
    // Safety snapshot precedes every effect, even when unchanged from last observed.
    const safety = await this.store.commit(current.files, current.contents, 'reconcile', {
      kind: 'unattributed'
    });
    const transaction = path.join(this.store.root, 'restore');
    try {
      await fs.mkdir(transaction);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('Restore recovery required.');
      throw e;
    }
    await fs.mkdir(path.join(transaction, 'backup'));
    await fs.mkdir(path.join(transaction, 'stage'));
    const entries: JournalEntry[] = review.paths.map((p) => ({
      path: p,
      before: current.files.find((f) => f.path === p) ?? null,
      after: target.files.find((f) => f.path === p) ?? null,
      moved: false,
      written: false,
      writeIntent: false
    }));
    const journal: Journal = {
      schemaVersion: 1,
      phase: 'applying',
      root: await fs.realpath(this.workspace),
      safety: safety.id,
      entries
    };
    const save = () => atomicWrite(path.join(transaction, 'journal.json'), JSON.stringify(journal));
    await save();
    try {
      for (let i = 0; i < entries.length; i++) {
        const item = entries[i];
        if (item.after)
          await fs.writeFile(
            path.join(transaction, 'stage', String(i)),
            await this.store.readBlob(item.after.hash),
            { flag: 'wx', mode: item.after.mode }
          );
      }
      await beforeWrite?.();
      if (
        changedPaths(
          current.files,
          (await scan(this.workspace, this.store.root, this.limits)).files
        ).length
      )
        throw new Error('Concurrent edit. Nothing restored.');
      for (let i = 0; i < entries.length; i++) {
        const item = entries[i];
        const destination = await this.destination(item.path);
        const backup = path.join(transaction, 'backup', String(i));
        if (item.before) {
          if ((await this.fingerprint(destination)) !== item.before.hash)
            throw new Error('Concurrent edit. Restore stopped.');
          await fs.rename(destination, backup);
          item.moved = true;
          await save();
          if ((await this.fingerprint(backup)) !== item.before.hash)
            throw new Error('Concurrent edit. Restore stopped.');
        } else if ((await this.fingerprint(destination)) !== null)
          throw new Error('Concurrent create. Restore stopped.');
        if (item.after) {
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await this.destination(item.path);
          // Exclusive create never replaces a file concurrently created at this path.
          item.writeIntent = true;
          await save();
          await fs.copyFile(
            path.join(transaction, 'stage', String(i)),
            destination,
            fs.constants.COPYFILE_EXCL
          );
          item.written = true;
          await fs.chmod(destination, item.after.mode);
          await save();
        }
      }
      const result = await scan(this.workspace, this.store.root, this.limits);
      if (changedPaths(target.files, result.files).length)
        throw new Error('Concurrent edit. Restore stopped.');
      const accepted = await this.store.commit(result.files, result.contents, 'reconcile', {
        kind: 'unattributed'
      });
      journal.phase = 'committed';
      await save();
      this.undoCheckpoint = safety;
      this.undoExpected = accepted;
      await fs.rm(transaction, { recursive: true, force: true });
      return accepted;
    } catch (e) {
      try {
        await this.rollback(transaction, journal);
      } catch {
        throw new Error('Concurrent edit preserved. Restore recovery required.');
      }
      throw e;
    }
  }
  async undo(observed: Checkpoint, unsaved: boolean) {
    if (!this.undoCheckpoint) throw new Error('No restore to undo.');
    const target = this.undoCheckpoint;
    if (!this.undoExpected || changedPaths(this.undoExpected.files, observed.files).length)
      throw new Error('Workspace drift. Undo blocked.');
    const review = await this.review(target, this.undoExpected, unsaved);
    return this.apply(review.token, target, unsaved);
  }
  async recover() {
    const transaction = path.join(this.store.root, 'restore');
    let journal: Journal;
    try {
      journal = JSON.parse(await fs.readFile(path.join(transaction, 'journal.json'), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await fs.access(transaction);
          throw new Error('Incomplete restore journal. Recovery required.');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw err;
        }
      }
      throw e;
    }
    if (
      journal.schemaVersion !== 1 ||
      journal.root !== (await fs.realpath(this.workspace)) ||
      !Array.isArray(journal.entries) ||
      journal.entries.some(
        (e) =>
          !safePath(e.path) ||
          (e.before && !/^[a-f0-9]{64}$/.test(e.before.hash)) ||
          (e.after && !/^[a-f0-9]{64}$/.test(e.after.hash))
      )
    )
      throw new Error('Invalid restore journal.');
    if (journal.phase === 'committed') {
      await fs.rm(transaction, { recursive: true, force: true });
      return;
    }
    await this.rollback(transaction, journal);
  }
  private async rollback(transaction: string, journal: Journal) {
    for (let i = journal.entries.length - 1; i >= 0; i--) {
      const item = journal.entries[i];
      const destination = await this.destination(item.path);
      const backup = path.join(transaction, 'backup', String(i));
      const backedUp = await this.fingerprint(backup);
      if (backedUp !== null) {
        const current = await this.fingerprint(destination);
        if (current !== null) {
          if (!item.after || current !== item.after.hash)
            throw new Error('Concurrent change preserved.');
          await fs.unlink(destination);
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(backup, destination, fs.constants.COPYFILE_EXCL);
        if (item.before) await fs.chmod(destination, item.before.mode);
      } else if (!item.before && item.after && item.writeIntent) {
        const current = await this.fingerprint(destination);
        if (current !== null) {
          if (current !== item.after.hash) throw new Error('Concurrent change preserved.');
          await fs.unlink(destination);
        }
      }
    }
    await fs.rm(transaction, { recursive: true, force: true });
  }
  private async destination(relative: string) {
    if (!safePath(relative)) throw new Error('Unsafe restore path.');
    const root = await fs.realpath(this.workspace);
    let current = root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('Symlink restore blocked.');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    return current;
  }
  private async fingerprint(file: string): Promise<string | null> {
    try {
      return hashBytes(await fs.readFile(file));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
}
