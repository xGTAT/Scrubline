import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ignore from 'ignore';
import { hashBytes } from '../store/store';
import type { TrackedFile } from '../bridge/timeline';
export interface ScanLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}
export const defaultLimits: ScanLimits = {
  maxFiles: 10000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024
};
const excluded = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.snapshots'
]);
export function inside(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export async function scan(root: string, storeRoot: string, limits = defaultLimits) {
  const realRoot = await fs.realpath(root);
  const store = path.resolve(storeRoot);
  if (inside(realRoot, store)) throw new Error('History storage must be outside the workspace.');
  const files: TrackedFile[] = [];
  const contents = new Map<string, Buffer>();
  const seen = new Set<string>();
  let total = 0;
  type Rule = { base: string; matcher: ReturnType<typeof ignore> };
  async function walk(dir: string, rules: Rule[]) {
    try {
      const rulePath = path.join(dir, '.gitignore');
      if (!inside(realRoot, await fs.realpath(rulePath))) throw new Error('External ignore file.');
      const text = await fs.readFile(rulePath, 'utf8');
      rules = [...rules, { base: dir, matcher: ignore().add(text) }];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const absolute = path.join(dir, entry.name);
      const rel = path.relative(realRoot, absolute).split(path.sep).join('/');
      if (
        excluded.has(entry.name) ||
        entry.name.startsWith('.env') ||
        entry.name === 'hook-events.jsonl' ||
        rules.some((r) =>
          r.matcher.ignores(
            path.relative(r.base, absolute).split(path.sep).join('/') +
              (entry.isDirectory() ? '/' : '')
          )
        )
      )
        continue;
      const resolved = await fs.realpath(absolute);
      if (
        resolved.split(path.sep).some((part) => excluded.has(part) || part.startsWith('.env')) ||
        rules.some(
          (r) =>
            inside(r.base, resolved) &&
            r.matcher.ignores(path.relative(r.base, resolved).split(path.sep).join('/'))
        )
      )
        throw new Error(`Excluded symlink target: ${rel}`);
      if (!inside(realRoot, resolved)) throw new Error(`External symlink: ${rel}`);
      const before = await fs.stat(absolute);
      if (before.isDirectory()) {
        if (entry.isSymbolicLink()) throw new Error(`Directory symlink unsupported: ${rel}`);
        await walk(absolute, rules);
        continue;
      }
      if (!before.isFile()) throw new Error(`Unsupported file: ${rel}`);
      if (
        before.size > limits.maxFileBytes ||
        files.length >= limits.maxFiles ||
        total + before.size > limits.maxTotalBytes
      )
        throw new Error('Capture limit reached. Increase limits.');
      const bytes = await fs.readFile(absolute);
      const after = await fs.stat(absolute);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino ||
        bytes.length !== before.size ||
        resolved !== (await fs.realpath(absolute))
      )
        throw new Error('Files changed during capture. Retry.');
      if (seen.has(rel.toLowerCase())) throw new Error(`Case-colliding paths: ${rel}`);
      seen.add(rel.toLowerCase());
      total += bytes.length;
      files.push({
        path: rel,
        hash: hashBytes(bytes),
        size: bytes.length,
        mode: before.mode & 0o777
      });
      contents.set(rel, bytes);
    }
  }
  await walk(realRoot, []);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, contents };
}
export function changedPaths(previous: TrackedFile[], current: TrackedFile[]) {
  const a = new Map(previous.map((f) => [f.path, `${f.hash}:${f.mode}`]));
  const b = new Map(current.map((f) => [f.path, `${f.hash}:${f.mode}`]));
  return [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();
}
