import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Checkpoint, TrackedFile, Attribution } from '../bridge/timeline';

export const hashBytes = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
export function safePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    value.split('/').every((p) => p !== '' && p !== '.' && p !== '..')
  );
}
function checkpointId(value: Omit<Checkpoint, 'id'>): string {
  return hashBytes(JSON.stringify(value));
}
export function migrate(value: unknown): Checkpoint {
  if (!value || typeof value !== 'object' || (value as Checkpoint).schemaVersion !== 1)
    throw new Error('Unsupported history version.');
  const c = value as Checkpoint;
  if (
    !HASH.test(c.id) ||
    !(c.parentId === null || HASH.test(c.parentId)) ||
    !Number.isFinite(Date.parse(c.createdAt)) ||
    !['baseline', 'watcher', 'save', 'reconcile'].includes(c.trigger) ||
    !Array.isArray(c.files) ||
    !c.attribution ||
    !['unattributed', 'hook'].includes(c.attribution.kind)
  )
    throw new Error('Invalid checkpoint.');
  if (
    c.branch &&
    (!/^[a-f0-9-]{36}$/.test(c.branch.id) ||
      typeof c.branch.name !== 'string' ||
      c.branch.name.length > 60)
  )
    throw new Error('Invalid branch.');
  const paths = new Set<string>();
  for (const f of c.files) {
    if (
      !safePath(f.path) ||
      !HASH.test(f.hash) ||
      !Number.isSafeInteger(f.size) ||
      f.size < 0 ||
      !Number.isInteger(f.mode) ||
      f.mode < 0 ||
      f.mode > 0o777 ||
      paths.has(f.path.toLowerCase())
    )
      throw new Error('Invalid tracked file.');
    paths.add(f.path.toLowerCase());
  }
  const { id, ...body } = c;
  if (checkpointId(body) !== id) throw new Error('Checkpoint checksum failed.');
  return c;
}
async function syncDirectory(dir: string) {
  // Windows does not support directory fsync through Node. File data is synced;
  // manifest rename is the commit point. Power-loss durability needs host testing.
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function atomicWrite(file: string, data: Uint8Array | string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export class HistoryStore {
  checkpoints: Checkpoint[] = [];
  private lockToken?: string;
  async acquireWriter() {
    if (this.lockToken) return;
    await fs.mkdir(this.root, { recursive: true });
    const lock = path.join(this.root, 'writer.lock');
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
        this.lockToken = token;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const old = JSON.parse(await fs.readFile(lock, 'utf8'));
        if (!Number.isInteger(old.pid)) throw new Error('Invalid storage lock.');
        try {
          process.kill(old.pid, 0);
          throw new Error('History is open in another window.');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
        }
        await fs.rm(lock);
      }
    }
    throw new Error('History storage is busy.');
  }
  async releaseWriter() {
    if (!this.lockToken) return;
    const token = this.lockToken;
    this.lockToken = undefined;
    const lock = path.join(this.root, 'writer.lock');
    const current = JSON.parse(await fs.readFile(lock, 'utf8'));
    if (current.token === token) await fs.rm(lock);
    this.lockToken = undefined;
  }
  constructor(
    readonly root: string,
    readonly quotaBytes = 512 * 1024 * 1024
  ) {}
  async open() {
    for (const dir of ['blobs', 'manifests'])
      await fs.mkdir(path.join(this.root, dir), { recursive: true });
    const all: Checkpoint[] = [];
    for (const name of await fs.readdir(path.join(this.root, 'manifests'))) {
      if (!name.endsWith('.json')) continue;
      const c = migrate(
        JSON.parse(await fs.readFile(path.join(this.root, 'manifests', name), 'utf8'))
      );
      if (name !== `${c.id}.json`) throw new Error('Manifest name mismatch.');
      for (const f of c.files) {
        const bytes = await this.readBlob(f.hash);
        if (bytes.length !== f.size) throw new Error('History size mismatch.');
      }
      all.push(c);
    }
    // Immutable manifests are a DAG. Reject missing parents and cycles.
    if (all.filter((c) => c.parentId === null).length > 1)
      throw new Error('History has multiple roots.');
    const ordered: Checkpoint[] = [];
    const byId = new Map(all.map((c) => [c.id, c]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    function visit(c: Checkpoint) {
      if (visited.has(c.id)) return;
      if (visiting.has(c.id)) throw new Error('History parent graph is inconsistent.');
      visiting.add(c.id);
      if (c.parentId) {
        const parent = byId.get(c.parentId);
        if (!parent) throw new Error('History parent graph is inconsistent.');
        visit(parent);
      }
      visiting.delete(c.id);
      visited.add(c.id);
      ordered.push(c);
    }
    for (const c of all) visit(c);
    // Preserve the workspace chain at the end for older consumers; alternatives are independent.
    ordered.sort((a, b) => Number(!a.branch) - Number(!b.branch));
    this.checkpoints = ordered;
    // Rebuildable cache only: manifests are authoritative after an interrupted write.
    await atomicWrite(
      path.join(this.root, 'index.json'),
      JSON.stringify({ schemaVersion: 1, ids: ordered.map((c) => c.id) })
    );
    return ordered;
  }
  async readBlob(hash: string) {
    if (!HASH.test(hash)) throw new Error('Invalid blob hash.');
    const bytes = await fs.readFile(path.join(this.root, 'blobs', hash));
    if (hashBytes(bytes) !== hash) throw new Error('History blob checksum failed.');
    return bytes;
  }
  async commit(
    files: TrackedFile[],
    contents: Map<string, Buffer>,
    trigger: Checkpoint['trigger'],
    attribution: Attribution,
    alternative?: { parentId: string; branch: { id: string; name: string } }
  ): Promise<Checkpoint> {
    let used = 0;
    for (const dir of ['blobs', 'manifests'])
      for (const name of await fs.readdir(path.join(this.root, dir)))
        used += (await fs.stat(path.join(this.root, dir, name))).size;
    const additions = new Map<string, Buffer>();
    for (const f of files) {
      const bytes = contents.get(f.path);
      if (!bytes || hashBytes(bytes) !== f.hash || bytes.length !== f.size)
        throw new Error('Capture bytes changed.');
      try {
        await this.readBlob(f.hash);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        additions.set(f.hash, bytes);
      }
    }
    if (alternative && !this.checkpoints.some((c) => c.id === alternative.parentId))
      throw new Error('Unknown branch parent.');
    const body: Omit<Checkpoint, 'id'> = {
      schemaVersion: 1,
      parentId:
        alternative?.parentId ?? this.checkpoints.filter((c) => !c.branch).at(-1)?.id ?? null,
      ...(alternative ? { branch: alternative.branch } : {}),
      createdAt: new Date().toISOString(),
      trigger,
      files,
      attribution
    };
    const c: Checkpoint = { id: checkpointId(body), ...body };
    const json = JSON.stringify(c);
    if (
      used + json.length + [...additions.values()].reduce((sum, b) => sum + b.length, 0) >
      this.quotaBytes
    )
      throw new Error('Storage limit reached. Increase quota.');
    for (const [hash, bytes] of additions)
      await atomicWrite(path.join(this.root, 'blobs', hash), bytes);
    await atomicWrite(path.join(this.root, 'manifests', `${c.id}.json`), json);
    this.checkpoints.push(c);
    this.checkpoints.sort((a, b) => Number(!a.branch) - Number(!b.branch));
    await atomicWrite(
      path.join(this.root, 'index.json'),
      JSON.stringify({ schemaVersion: 1, ids: this.checkpoints.map((item) => item.id) })
    );
    return c;
  }
  async compact() {
    // Preserve every committed checkpoint; collect only unreachable capture debris.
    const referenced = new Set(this.checkpoints.flatMap((c) => c.files.map((f) => f.hash)));
    let removedBytes = 0;
    for (const name of await fs.readdir(path.join(this.root, 'blobs'))) {
      if (!HASH.test(name) || referenced.has(name)) continue;
      const file = path.join(this.root, 'blobs', name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      removedBytes += stat.size;
      await fs.unlink(file);
    }
    return removedBytes;
  }
  async materialize(c: Checkpoint, destination: string) {
    // Only isolated, empty destinations. Workspace restore belongs to M2.
    const validated = migrate(c);
    await fs.mkdir(destination, { recursive: true });
    if ((await fs.readdir(destination)).length)
      throw new Error('Snapshot destination must be empty.');
    const root = await fs.realpath(destination);
    for (const f of validated.files) {
      const target = path.join(root, ...f.path.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await this.readBlob(f.hash), { flag: 'wx', mode: f.mode });
    }
  }
  }
