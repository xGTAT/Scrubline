import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryStore, hashBytes, atomicWrite } from '../store/store';
import type { Checkpoint } from '../bridge/timeline';
import { declarationChanges, applyUnits, type CssUnit } from './change-units';
import { validateGuard, type LayoutGuard } from '../layout/types';
import { PreviewRunner, type PreviewConfig } from '../preview/runner';
import { specificationKey } from '../preview/spec';
import { scan, changedPaths } from '../capture/scanner';
import type { Restore } from '../review/restore';
// Deliberately small independent longhand set. Shorthand/cascade ownership is not inferred.
const independent = new Set(['min-width', 'max-width', 'min-height', 'max-height']);
export function inverseCss(current: string, units: readonly CssUnit[]) {
  if (!units.length || units.some((u) => !independent.has(u.property)))
    throw new Error('Rollback supports independent min/max width/height declarations only.');
  const inverse = units.map((u) => ({ ...u, before: u.after, after: u.before }));
  // Require unique property ownership in this file, including other selector/at-rule scopes.
  declarationChanges('check.css', current, current);
  if (/(?:^|[;{])\s*all\s*:/.test(current)) throw new Error('Cascade-reset shorthand unsupported.');
  for (const unit of units) {
    const matches = current.match(new RegExp(`(?:^|[;{])\\s*${unit.property}\\s*:`, 'g')) ?? [];
    if (matches.length !== 1) throw new Error('Overlapping CSS property ownership refused.');
  }
  const result = applyUnits(current, inverse);
  if (
    result === current ||
    declarationChanges('check.css', current, result).length !== units.length
  )
    throw new Error('Declaration absent or changed since investigation.');
  return result;
}
export interface RollbackCandidate {
  target: Checkpoint;
  current: Checkpoint;
  config: PreviewConfig;
  guards: LayoutGuard[];
  specification: string;
  changes: CssUnit[];
}
export async function guardsPass(
  store: HistoryStore,
  cp: Checkpoint,
  config: PreviewConfig,
  guards: LayoutGuard[],
  cancelled: () => boolean,
  workspace?: string
) {
  for (const guard of guards) {
    validateGuard(guard);
    for (let repeat = 0; repeat < 2; repeat++) {
      if (cancelled()) throw new Error('Rollback validation cancelled.');
      const directory = `rollback-probes/${randomUUID()}`;
      const runner = new PreviewRunner({ ...config, guard, port: config.port + 6 }, store);
      try {
        const rendered = workspace
          ? await (async () => {
              const origin = await runner.start(workspace, true);
              const screenshot = path.join(store.root, directory, `${cp.id}.png`);
              await fs.mkdir(path.dirname(screenshot), { recursive: true });
              const url = new URL(config.route ?? '/', origin).toString();
              await runner.screenshot(url, screenshot, cp);
              return { url, screenshot };
            })()
          : await runner.historical(cp, true, directory);
        if (!rendered.url || !rendered.screenshot)
          throw new Error('Fresh guard evidence unavailable.');
        const result = JSON.parse(await fs.readFile(`${rendered.screenshot}.layout.json`, 'utf8'));
        if (result.outcome !== 'pass') throw new Error(`Guard ${guard.kind} did not pass twice.`);
      } finally {
        await runner.stop();
        await fs.rm(path.join(store.root, directory), { recursive: true, force: true });
      }
    }
  }
}
export async function prepareRollback(
  store: HistoryStore,
  current: Checkpoint,
  good: Checkpoint,
  bad: Checkpoint,
  units: CssUnit[],
  config: PreviewConfig,
  repair: LayoutGuard,
  keep: LayoutGuard[],
  cancelled: () => boolean
): Promise<RollbackCandidate> {
  if (!units.length || units.length > 16 || keep.length > 3)
    throw new Error('Choose 1-16 declarations and 0-3 keep guards.');
  [repair, ...keep].forEach(validateGuard);
  const files = current.files.map((f) => ({ ...f }));
  for (const p of new Set(units.map((u) => u.path))) {
    const a = good.files.find((f) => f.path === p),
      b = bad.files.find((f) => f.path === p),
      now = files.find((f) => f.path === p);
    if (!a || !b || !now || a.mode !== b.mode || now.mode !== b.mode)
      throw new Error('CSS file/mode identity unavailable.');
    const before = (await store.readBlob(a.hash)).toString('utf8'),
      after = (await store.readBlob(b.hash)).toString('utf8'),
      text = (await store.readBlob(now.hash)).toString('utf8');
    const actual = declarationChanges(p, before, after);
    const chosen = units.filter((u) => u.path === p);
    if (chosen.some((u) => !actual.some((v) => JSON.stringify(u) === JSON.stringify(v))))
      throw new Error('Investigation source changed.');
    declarationChanges(p, after, text); // Later structural edits are not silently rebased.
    const bytes = Buffer.from(inverseCss(text, chosen));
    now.hash = hashBytes(bytes);
    let used = 0;
    for (const dir of ['blobs', 'manifests'])
      for (const name of await fs.readdir(path.join(store.root, dir)))
        used += (await fs.stat(path.join(store.root, dir, name))).size;
    if (used + bytes.length > store.quotaBytes) throw new Error('Storage limit reached.');
    await atomicWrite(path.join(store.root, 'blobs', now.hash), bytes);
    now.size = bytes.length;
  }
  const { id: _id, ...body } = current;
  const candidateBody = { ...body, files };
  const target = { ...candidateBody, id: hashBytes(JSON.stringify(candidateBody)) };
  void _id;
  await guardsPass(store, current, config, keep, cancelled);
  await guardsPass(store, target, config, [repair, ...keep], cancelled);
  return {
    target,
    current,
    config,
    guards: [repair, ...keep],
    specification: specificationKey(config),
    changes: units
  };
}
export async function applyRollback(
  restore: Restore,
  candidate: RollbackCandidate,
  token: string,
  config: PreviewConfig,
  dirty: () => boolean,
  cancelled: () => boolean
) {
  if (specificationKey(config) !== candidate.specification)
    throw new Error('Render settings changed. Review rollback again.');
  await guardsPass(restore.store, candidate.target, config, candidate.guards, cancelled);
  return restore.apply(token, candidate.target, dirty(), undefined, async () => {
    if (dirty() || cancelled()) throw new Error('Rollback changed/cancelled during apply.');
    const current = await scan(restore.workspace, restore.store.root, restore.limits);
    if (changedPaths(candidate.target.files, current.files).length)
      throw new Error('Concurrent edit during rollback.');
    await guardsPass(
      restore.store,
      candidate.target,
      config,
      candidate.guards,
      cancelled,
      restore.workspace
    );
    if (dirty() || cancelled()) throw new Error('Rollback changed/cancelled after verification.');
  });
}
