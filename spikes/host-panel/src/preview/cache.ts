import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../store/store';
import type { Checkpoint } from '../bridge/timeline';
import { readReceipt } from './receipt';
export const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export { specificationKey as renderKey } from './spec';
export class RenderCache {
  constructor(
    readonly root: string,
    readonly key: string,
    readonly maxBytes = 200 * 1024 * 1024
  ) {}
  private file(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid checkpoint id.');
    return path.join(this.root, 'render-cache', this.key, `${id}.png`);
  }
  async get(id: string): Promise<string | undefined> {
    const file = this.file(id);
    try {
      const bytes = await fs.readFile(file);
      if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG)) return;
      const hasReceipt = await fs.access(`${file}.receipt.json`).then(
        () => true,
        () => false
      );
      if (hasReceipt && !(await this.receipt(id))) return;
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  async regions(id: string) {
    try {
      return JSON.parse(await fs.readFile(`${this.file(id)}.json`, 'utf8'));
    } catch {
      return [];
    }
  }
  async receipt(id: string) {
    return readReceipt(this.file(id), id, this.key);
  }
  private writes = Promise.resolve();
  put(id: string, source: string): Promise<string> {
    const job = this.writes.catch(() => {}).then(() => this.commit(id, source));
    this.writes = job.then(
      () => {},
      () => {}
    );
    return job;
  }
  private async commit(id: string, source: string) {
    const bytes = await fs.readFile(source);
    const supplied = await fs.readFile(`${source}.receipt.json`).catch(() => undefined);
    if (supplied && !(await readReceipt(source, id, this.key)))
      throw new Error('Render receipt invalid.');
    if (!bytes.subarray(0, 8).equals(PNG)) throw new Error('Render did not produce a PNG.');
    const directory = path.dirname(this.file(id));
    await fs.mkdir(directory, { recursive: true });
    let used = 0;
    const groups = new Map<string, { size: number; mtime: number; files: string[] }>();
    const cacheRoot = path.join(this.root, 'render-cache');
    for (const config of await fs.readdir(cacheRoot)) {
      const dir = path.join(cacheRoot, config);
      if (!(await fs.lstat(dir)).isDirectory()) continue;
      for (const entry of await fs.readdir(dir)) {
        const file = path.join(dir, entry);
        if (
          file !== this.file(id) &&
          file !== `${this.file(id)}.json` &&
          file !== `${this.file(id)}.receipt.json` &&
          file !== `${this.file(id)}.layout.json`
        ) {
          const stat = await fs.stat(file);
          used += stat.size;
          const key = file.replace(/\.(receipt|layout)\.json$|\.json$/, '');
          const group = groups.get(key) ?? { size: 0, mtime: 0, files: [] };
          group.size += stat.size;
          group.mtime = Math.max(group.mtime, stat.mtimeMs);
          group.files.push(file);
          groups.set(key, group);
        }
      }
    }
    const metadata = await fs.readFile(`${source}.json`).catch(() => Buffer.alloc(0));
    const receipt = await fs.readFile(`${source}.receipt.json`).catch(() => Buffer.alloc(0));
    const layout = await fs.readFile(`${source}.layout.json`).catch(() => Buffer.alloc(0));
    const incoming = bytes.length + metadata.length + receipt.length + layout.length;
    if (used + incoming > this.maxBytes) {
      // Evict the oldest cached renders first. Renders are regenerable; checkpoints are not touched.
      for (const group of [...groups.values()].sort((a, b) => a.mtime - b.mtime)) {
        if (used + incoming <= this.maxBytes) break;
        for (const file of group.files) await fs.rm(file, { force: true });
        used -= group.size;
      }
      if (used + incoming > this.maxBytes) throw new Error('Render cache limit reached (200 MB).');
    }
    await atomicWrite(this.file(id), bytes);
    try {
      await atomicWrite(`${this.file(id)}.json`, await fs.readFile(`${source}.json`));
    } catch {
      await fs.rm(`${this.file(id)}.json`, { force: true });
    }
    if (receipt.length) await atomicWrite(`${this.file(id)}.receipt.json`, receipt);
    else await fs.rm(`${this.file(id)}.receipt.json`, { force: true });
    if (layout.length) await atomicWrite(`${this.file(id)}.layout.json`, layout);
    else await fs.rm(`${this.file(id)}.layout.json`, { force: true });
    return this.file(id);
  }
  async available(checkpoints: readonly Checkpoint[]) {
    const ids: string[] = [];
    for (const cp of checkpoints) if (await this.get(cp.id)) ids.push(cp.id);
    return ids;
  }
  async clear() {
    await fs.rm(path.join(this.root, 'render-cache'), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
  }
}
export interface RenderProgress {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  cancelled?: boolean;
  message?: string;
}
export async function prepareHistory(
  checkpoints: readonly Checkpoint[],
  cache: RenderCache,
  render: (c: Checkpoint) => Promise<string>,
  cancelled: () => boolean,
  notify: (p: RenderProgress) => void,
  failure?: (checkpoint: string, message: string) => void
) {
  const progress: RenderProgress = { running: true, done: 0, total: checkpoints.length, failed: 0 };
  notify({ ...progress });
  for (const c of checkpoints) {
    if (cancelled()) break;
    try {
      if (!(await cache.get(c.id))) {
        const image = await render(c);
        if (cancelled()) break;
        await cache.put(c.id, image);
      }
    } catch (e) {
      if (cancelled()) break;
      progress.failed++;
      progress.message = e instanceof Error ? e.message : 'Render failed.';
      failure?.(c.id, progress.message);
    }
    progress.done++;
    notify({ ...progress });
  }
  progress.running = false;
  progress.cancelled = cancelled();
  notify({ ...progress });
  return progress;
}
// Persistent rendered screenshots, no project code in cached playback.
