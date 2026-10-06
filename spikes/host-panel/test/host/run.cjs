const { runTests } = require('@vscode/test-electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const net = require('node:net');
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port - 3));
    });
  });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-host-'));
  const workspace = path.join(temp, 'project');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'baseline.txt'), 'baseline');
  await fs.mkdir(path.join(workspace, '.vscode'));
  await fs.writeFile(
    path.join(workspace, 'server.cjs'),
    "require('http').createServer((q,r)=>r.end('<h1>Real host render</h1>')).listen(process.env.PORT,'127.0.0.1')"
  );
  await fs.writeFile(
    path.join(workspace, '.vscode/settings.json'),
    JSON.stringify({
      'scrubline.previewCommand': '"' + process.execPath + '" server.cjs',
      'scrubline.previewPort': port,
      'scrubline.chromiumPath': require('playwright-core').chromium.executablePath()
    })
  );
  const workspaceFile = path.join(temp, 'lab.code-workspace');
  await fs.writeFile(workspaceFile, JSON.stringify({ folders: [{ path: workspace }] }));
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.resolve(__dirname, 'suite.cjs'),
      launchArgs: [
        workspaceFile,
        '--user-data-dir',
        path.join(temp, 'profile'),
        '--extensions-dir',
        path.join(temp, 'extensions'),
        '--disable-workspace-trust',
        '--no-sandbox',
        '--disable-gpu'
      ],
      version: '1.96.4'
    });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
