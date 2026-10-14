import { test, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { installMcpRuntime } from '../../src/mcp/install';
test('MCP runtime survives removed version directory and refreshes at the same stable path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-mcp-install-'));
  try {
    const v1 = path.join(root, 'extensions', '0.8.4'),
      v2 = path.join(root, 'extensions', '0.8.5'),
      storage = path.join(root, 'storage');
    for (const v of [v1, v2]) await fs.mkdir(path.join(v, 'dist'), { recursive: true });
    await fs.writeFile(path.join(v1, 'dist', 'mcp.js'), 'first');
    await fs.writeFile(path.join(v2, 'dist', 'mcp.js'), 'second');
    const stable = await installMcpRuntime(v1, storage);
    await fs.rm(v1, { recursive: true, force: true });
    expect(await fs.readFile(stable, 'utf8')).toBe('first');
    expect(await installMcpRuntime(v2, storage)).toBe(stable);
    expect(await fs.readFile(stable, 'utf8')).toBe('second');
    await expect(installMcpRuntime(v1, storage)).rejects.toThrow('missing');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
