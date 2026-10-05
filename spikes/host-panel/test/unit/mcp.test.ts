import { test, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server';
import { McpBridge } from '../../src/mcp/bridge';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
test('MCP advertises exactly two tools; restore only requests reviewed confirmation', async () => {
  const requests: unknown[] = [];
  const server = createMcpServer(async (name, id) => {
    requests.push({ name, id });
    return name === 'list_checkpoints'
      ? { checkpoints: [{ id: 'a'.repeat(64) }] }
      : { status: 'pending_user_confirmation', checkpoint: id };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'scrubline-test', version: '1' });
  await client.connect(b);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['list_checkpoints', 'restore_checkpoint']);
    const result = await client.callTool({
      name: 'restore_checkpoint',
      arguments: { checkpoint: 'a'.repeat(64) }
    });
    expect(JSON.stringify(result)).toContain('pending_user_confirmation');
    expect(requests).toEqual([{ name: 'restore_checkpoint', id: 'a'.repeat(64) }]);
    const invalid = await client.callTool({
      name: 'restore_checkpoint',
      arguments: { checkpoint: '../../escape' }
    });
    expect(invalid.isError).toBe(true);
    expect(requests).toHaveLength(1);
  } finally {
    await client.close();
    await server.close();
  }
});
test('local bridge denies browser origins, bad host/token, oversized/unknown actions; never applies', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-mcp-'));
  const requests: string[] = [];
  const bridge = new McpBridge(temp, {
    list: async () => ({ checkpoints: [] }),
    review: async (id) => {
      requests.push(id);
      return { status: 'pending_user_confirmation' };
    }
  });
  try {
    const connection = await bridge.start();
    const data = JSON.parse(await fs.readFile(connection, 'utf8'));
    const request = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(data.url, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + data.token, ...headers },
        body: JSON.stringify(body)
      });
    expect((await fetch(data.url, { method: 'POST', body: '{}' })).status).toBe(403);
    expect(
      (await request({ name: 'list_checkpoints' }, { origin: 'http://localhost' })).status
    ).toBe(403);
    const { request: raw } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = raw(
        data.url,
        {
          method: 'POST',
          headers: { host: 'evil.example', authorization: 'Bearer ' + data.token }
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        }
      );
      req.end(JSON.stringify({ name: 'list_checkpoints' }));
    });
    expect(status).toBe(403);
    expect((await request({ name: 'apply', token: 'anything' })).status).toBe(400);
    expect((await request({ name: 'restore_checkpoint', checkpoint: '../unsafe' })).status).toBe(
      400
    );
    expect((await request({ name: 'list_checkpoints', padding: 'a'.repeat(5000) })).status).toBe(
      413
    );
    const response = await request({ name: 'restore_checkpoint', checkpoint: 'b'.repeat(64) });
    expect(await response.json()).toEqual({ status: 'pending_user_confirmation' });
    expect(requests).toEqual(['b'.repeat(64)]);
    if (process.platform !== 'win32') expect((await fs.stat(connection)).mode & 0o777).toBe(0o600);
  } finally {
    await bridge.stop();
    await expect(fs.access(path.join(temp, 'mcp-connection.json'))).rejects.toThrow();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
test('packaged stdio responds with JSON-RPC lines only', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-mcp-stdio-'));
  const bridge = new McpBridge(temp, {
    list: async () => ({ checkpoints: [] }),
    review: async () => ({ status: 'pending_user_confirmation' })
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const connection = await bridge.start();
    const { build } = await import('esbuild');
    const executable = path.join(temp, 'mcp.cjs');
    await build({
      entryPoints: [path.resolve('src/mcp/server.ts')],
      bundle: true,
      outfile: executable,
      platform: 'node',
      format: 'cjs'
    });
    child = spawn(process.execPath, [executable, '--connection', connection], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout!.on('data', (chunk) => (stdout += chunk));
    child.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' }
        }
      }) + '\n'
    );
    await expect.poll(() => stdout, { timeout: 5000 }).toContain('"id":1');
    for (const line of stdout.trim().split('\n')) expect(JSON.parse(line).jsonrpc).toBe('2.0');
    child.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
    );
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    await expect.poll(() => stdout, { timeout: 5000 }).toContain('restore_checkpoint');
  } finally {
    child?.kill();
    await bridge.stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
