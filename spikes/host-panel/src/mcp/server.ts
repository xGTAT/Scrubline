import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'node:fs/promises';
export function createMcpServer(call: (name: string, checkpoint?: string) => Promise<unknown>) {
  const server = new McpServer(
    { name: 'scrubline', version: '0.3.0' },
    { maxToolInputElements: 8 }
  );
  server.registerTool(
    'list_checkpoints',
    {
      description: 'List current Scrubline checkpoint ids and redacted changed paths.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(await call('list_checkpoints')) }]
    })
  );
  server.registerTool(
    'restore_checkpoint',
    {
      description:
        'Request review of a checkpoint in the Scrubline panel. Does not write files. User must confirm there.',
      inputSchema: { checkpoint: z.string().regex(/^[a-f0-9]{64}$/) },
      annotations: { readOnlyHint: true }
    },
    async ({ checkpoint }) => ({
      content: [
        { type: 'text', text: JSON.stringify(await call('restore_checkpoint', checkpoint)) }
      ]
    })
  );
  return server;
}
export async function run(connection: string) {
  const data = JSON.parse(await fs.readFile(connection, 'utf8'));
  const url = new URL(data.url);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/tool' ||
    typeof data.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.token)
  )
    throw new Error('Invalid local connection.');
  const server = createMcpServer(async (name, checkpoint) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + data.token, 'content-type': 'application/json' },
      body: JSON.stringify({ name, checkpoint }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('Scrubline refused request. Check the panel.');
    return response.json();
  });
  await server.connect(
    new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 })
  );
}
if (require.main === module) {
  const index = process.argv.indexOf('--connection');
  if (index < 0 || !process.argv[index + 1]) {
    process.stderr.write('Use --connection with the private Scrubline connection file.\n');
    process.exitCode = 1;
  } else
    run(process.argv[index + 1]).catch(() => {
      process.stderr.write('Scrubline MCP unavailable. Enable it in a trusted workspace first.\n');
      process.exitCode = 1;
    });
}
