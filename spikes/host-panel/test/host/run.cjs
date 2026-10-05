const { runTests } = require('@vscode/test-electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-host-'));
  const workspace = path.join(temp, 'project');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'baseline.txt'), 'baseline');
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.resolve(__dirname, 'suite.cjs'),
      launchArgs: [
        workspace,
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
