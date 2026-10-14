const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
(async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-packaged-mcp-'));
  let client;
  try {
    const bundle = execFileSync('unzip', ['-p', process.argv[2], 'extension/dist/mcp.js'], {
      maxBuffer: 5 * 1024 * 1024
    });
    const runtime = path.join(root, 'scrubline-mcp.cjs');
    await fs.writeFile(runtime, bundle);
    const connection = path.join(root, 'connection.json');
    await fs.writeFile(
      connection,
      JSON.stringify({ url: 'http://127.0.0.1:49100/tool', token: 'a'.repeat(64) })
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [runtime, '--connection', connection],
      stderr: 'pipe'
    });
    let errors = '';
    transport.stderr?.on('data', (d) => (errors += d));
    client = new Client({ name: 'scrubline-package-verifier', version: '1.0.0' });
    await client.connect(transport, { timeout: 10000 });
    const tools = await client.listTools();
    if (
      !tools.tools.some((t) => t.name === 'list_checkpoints') ||
      !tools.tools.some((t) => t.name === 'restore_checkpoint')
    )
      throw Error('Missing expected tools');
    console.log(
      JSON.stringify({
        initialize: 'PASS',
        server: client.getServerVersion(),
        tools: tools.tools.map((t) => t.name),
        bundleBytes: bundle.length,
        stderr: errors
      })
    );
  } finally {
    await client?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
