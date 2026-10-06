import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hashBytes, atomicWrite } from './store';
export async function scopedStore(base: string, workspace: string) {
  const canonical = await fs.realpath(workspace);
  const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const root = path.join(base, 'workspaces', hashBytes(identity));
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, 'workspace.json');
  try {
    const binding = JSON.parse(await fs.readFile(file, 'utf8'));
    if (binding.version !== 1 || binding.identity !== identity)
      throw new Error('History workspace binding mismatch.');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await atomicWrite(file, JSON.stringify({ version: 1, identity }));
  }
  // Legacy workspace-only stores are intentionally not assigned to an unverified folder.
  return root;
}
// Legacy history is preserved in place, never silently migrated or deleted.
