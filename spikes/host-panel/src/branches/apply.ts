import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Checkpoint } from '../bridge/timeline';
import { Restore } from '../review/restore';
import { scan, changedPaths } from '../capture/scanner';
import { validateCandidate } from './validate';
export async function applySelective(
  restore: Restore,
  target: Checkpoint,
  token: string,
  unsaved: boolean,
  command: string,
  dirty: () => boolean = () => unsaved
) {
  const directory = path.join(restore.store.root, 'validate', randomUUID());
  await restore.store.materialize(target, directory);
  try {
    await validateCandidate(command, directory);
    const checked = await scan(directory, restore.store.root, restore.limits);
    if (changedPaths(target.files, checked.files).length)
      throw new Error('Build/test changed candidate sources. Nothing applied.');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  const accepted = await restore.apply(token, target, dirty());
  try {
    await validateCandidate(command, restore.workspace);
    const actual = await scan(restore.workspace, restore.store.root, restore.limits);
    if (changedPaths(accepted.files, actual.files).length)
      throw new Error('Post-apply modified tracked sources.');
  } catch {
    try {
      await restore.undo(accepted, dirty());
    } catch {
      throw new Error('Post-apply failed; concurrent bytes preserved. Review safety checkpoint.');
    }
    throw new Error('Post-apply failed. Applied files rolled back.');
  }
  return accepted;
}
