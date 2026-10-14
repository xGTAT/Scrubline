import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, hashBytes } from '../store/store';
// Copied client definitions must not depend on versioned extension install directories.
export async function installMcpRuntime(extensionPath: string, storagePath: string) {
  const source = path.join(extensionPath, 'dist', 'mcp.js');
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(source);
  } catch {
    throw new Error('Scrubline MCP bundle is missing. Reinstall the VSIX and reload the IDE.');
  }
  if (!bytes.length) throw new Error('Scrubline MCP bundle is empty. Reinstall the VSIX.');
  const destination = path.join(storagePath, 'mcp-runtime', 'scrubline-mcp.cjs');
  const existing = await fs.readFile(destination).catch(() => undefined);
  if (!existing || hashBytes(existing) !== hashBytes(bytes)) await atomicWrite(destination, bytes);
  return destination;
}
