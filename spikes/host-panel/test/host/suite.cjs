const assert = require('node:assert/strict');
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
exports.run = async () => {
  const extension = vscode.extensions.getExtension('scrubline.scrubline-panel');
  assert.ok(extension, 'extension registered');
  const api = await extension.activate();
  assert.equal(api.getTimeline().status, 'ready');
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await fs.writeFile(path.join(root, 'host-edit.txt'), 'saved in extension host\r\n');
  const watchDeadline = Date.now() + 10000;
  while (
    !api.getTimeline().rows.at(-1)?.changedPaths.includes('host-edit.txt') &&
    Date.now() < watchDeadline
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    api.getTimeline().rows.at(-1).changedPaths.includes('host-edit.txt'),
    'watcher captured save'
  );
  await api.capture();
  const state = api.getTimeline();
  assert.ok(state.rows.length >= 2);
  assert.ok(state.rows.at(-1).changedPaths.includes('host-edit.txt'));
  assert.equal(state.rows.at(-1).attribution.kind, 'unattributed');
  const baseline = state.rows[0].id;
  assert.ok(api.getStoreRoot().includes('workspaces'), 'canonical folder-bound storage');
  await api.prepareRenders();
  assert.equal(
    api.getTimeline().rendering.failed,
    0,
    'folder-scoped preview settings used in saved workspace: ' +
      JSON.stringify(api.getTimeline().rendering)
  );
  const cached = await api.readCached(baseline);
  assert.ok(cached, 'pre-render PNG persisted');
  if (process.env.SCRUBLINE_RENDER_EVIDENCE)
    await fs.copyFile(cached, process.env.SCRUBLINE_RENDER_EVIDENCE);
  const stat = await fs.stat(cached);
  await api.prepareRenders();
  assert.equal((await fs.stat(cached)).mtimeMs, stat.mtimeMs, 'cache hit does not regenerate PNG');

  const connection = await vscode.commands.executeCommand('scrubline.startMcp');
  const mcpDocument = vscode.window.activeTextEditor.document.getText();
  const definition = JSON.parse(mcpDocument).mcpServers.scrubline;
  assert.ok(definition.args[0].endsWith('scrubline-mcp.cjs'), 'stable runtime filename');
  assert.ok(
    !definition.args[0].includes(extension.extensionPath),
    'no versioned install dependency'
  );
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'scrubline-host-check', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: 'node', args: definition.args }));
    assert.equal(client.getServerVersion().version, '0.8.12');
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'list_checkpoints'));
    const listed = await client.callTool({ name: 'list_checkpoints', arguments: {} });
    assert.ok(JSON.parse(listed.content[0].text).checkpoints.length >= 2);
  } finally {
    await client.close();
  }
  const config = JSON.parse(await fs.readFile(connection, 'utf8'));
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + config.token },
    body: JSON.stringify({ name: 'restore_checkpoint', checkpoint: baseline })
  });
  assert.equal((await response.json()).status, 'pending_user_confirmation');
  assert.equal(
    await fs.readFile(path.join(root, 'host-edit.txt'), 'utf8'),
    'saved in extension host\r\n',
    'MCP must not restore without panel confirmation'
  );
  assert.equal(api.getTimeline().review.checkpoint, baseline);
  const review = api.getTimeline().review;
  await api.apply(baseline, review.token);
  await assert.rejects(fs.access(path.join(root, 'host-edit.txt')));
  await api.undo();
  assert.equal(
    await fs.readFile(path.join(root, 'host-edit.txt'), 'utf8'),
    'saved in extension host\r\n'
  );
  const fork = await api.fork(baseline, 'Host fork');
  await fs.writeFile(path.join(fork.directory, 'baseline.txt'), 'branch baseline');
  const forkCheckpoint = await api.captureBranch(fork.id);
  assert.equal(await fs.readFile(path.join(root, 'baseline.txt'), 'utf8'), 'baseline');
  const selective = await api.reviewFiles(forkCheckpoint.id, ['baseline.txt']);
  assert.equal(selective.review.conflicts.length, 0);
  assert.equal(selective.review.paths.join(','), 'baseline.txt');
  // Alternatives webpage previews: each branch head renders to its own preview.
  await vscode.commands.executeCommand('scrubline.openPanel');
  let branchPreview;
  const previewDeadline = Date.now() + 60000;
  do {
    await api.previewBranches();
    branchPreview = api.getTimeline().branchPreviews?.[fork.id];
    if (branchPreview?.image) break;
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < previewDeadline);
  assert.ok(branchPreview, 'branch preview published');
  assert.equal(branchPreview.checkpoint, forkCheckpoint.id, 'preview bound to branch head');
  assert.ok(branchPreview.image, 'branch preview screenshot produced');
  // A capture that moves the branch head invalidates the old preview: the next
  // render rebinds to the new head instead of serving the stale image.
  await fs.writeFile(path.join(fork.directory, 'moved.txt'), 'head moved');
  const movedHead = await api.captureBranch(fork.id);
  await api.previewBranches();
  const rebound = api.getTimeline().branchPreviews?.[fork.id];
  assert.ok(rebound?.image, 'preview re-rendered after head moved');
  assert.equal(rebound.checkpoint, movedHead.id, 'preview rebound to new branch head');
  // Sequential lifecycle: the dedicated preview runner releases its port.
  const settings = JSON.parse(await fs.readFile(path.join(root, '.vscode/settings.json'), 'utf8'));
  const net = require('node:net');
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(settings['scrubline.previewPort'] + 8, '127.0.0.1', () =>
      probe.close(() => resolve())
    );
  });
  await vscode.workspace
    .getConfiguration('scrubline', vscode.workspace.workspaceFolders[0].uri)
    .update(
      'previewCommand',
      'node different-command.cjs',
      vscode.ConfigurationTarget.WorkspaceFolder
    );
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(
    await api.readCached(baseline),
    undefined,
    'config changed invalidates render key without reload'
  );
  // Configuration refresh is asynchronous in native IDE hosts. Wait for the
  // render request to be accepted before testing cancellation of that request.
  let job;
  const renderDeadline = Date.now() + 10000;
  do {
    job = api.prepareRenders();
    if (api.getTimeline().rendering?.running) break;
    await job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < renderDeadline);
  assert.equal(api.getTimeline().rendering?.running, true, 'render request started');
  api.cancelRenders();
  await job;
  assert.equal(
    api.getTimeline().rendering.cancelled,
    true,
    'cancel is bounded and does not commit in-flight result'
  );
  assert.equal(await api.readCached(baseline), undefined);
  await vscode.workspace
    .getConfiguration('scrubline', vscode.workspace.workspaceFolders[0].uri)
    .update('previewCommand', 'node server.cjs', vscode.ConfigurationTarget.WorkspaceFolder);
  await new Promise((r) => setTimeout(r, 300));
  await api.prepareRenders();
  assert.equal(
    api.getTimeline().rendering.failed,
    0,
    'recovery after failed/cancelled render and settings change'
  );
  // Backend capture: the real host render recorded sanitized request metadata.
  const storeRoot = api.getStoreRoot();
  const screenshotsRoot = path.join(storeRoot, 'screenshots');
  const specDirs = await fs.readdir(screenshotsRoot).catch(() => []);
  let backendArtifact;
  for (const dir of specDirs) {
    const candidate = path.join(screenshotsRoot, dir, `${baseline}.backend.json`);
    if (
      await fs.access(candidate).then(
        () => true,
        () => false
      )
    ) {
      backendArtifact = JSON.parse(await fs.readFile(candidate, 'utf8'));
      break;
    }
  }
  assert.ok(backendArtifact, 'backend capture artifact written for host render');
  assert.equal(backendArtifact.checkpoint, baseline);
  assert.equal(backendArtifact.version, 1);
  const seen = backendArtifact.entries.map((e) => `${e.method} ${e.path}`);
  assert.ok(seen.includes('GET /api/status'), `capture has the GET route: ${seen}`);
  assert.ok(seen.includes('POST /api/items'), `capture has the POST route: ${seen}`);
  const statusEntry = backendArtifact.entries.find((e) => e.path === '/api/status');
  assert.deepEqual(statusEntry.queryKeys, ['session']);
  assert.equal(statusEntry.mutation, false);
  assert.equal(
    backendArtifact.entries.find((e) => e.path === '/api/items').mutation,
    true,
    'POST flagged as mutation'
  );
  assert.ok(
    !JSON.stringify(backendArtifact).includes('HOSTSECRET'),
    'query values never serialized'
  );
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('scrubline.deleteHistory'));
  assert.ok(commands.includes('scrubline.compactHistory'));
  assert.ok(!commands.includes('scrubline.exportReplay'), 'replay deferred');
  await vscode.commands.executeCommand('scrubline.openPanel');
  // Simulate loading a replacement bundle without restarting this IDE host.
  const replacement = require(path.join(extension.extensionPath, 'dist', 'extension.js'));
  const subscriptions = [];
  const storageUri = vscode.Uri.file(path.dirname(path.dirname(api.getStoreRoot())));
  const memento = () => {
    const values = new Map();
    return {
      get: (key, fallback) => (values.has(key) ? values.get(key) : fallback),
      update: async (key, value) => {
        if (value === undefined) values.delete(key);
        else values.set(key, value);
      },
      keys: () => [...values.keys()]
    };
  };
  const nextApi = await replacement.activate({
    extension,
    extensionPath: extension.extensionPath,
    extensionUri: extension.extensionUri,
    storageUri,
    globalStorageUri: vscode.Uri.file(
      path.join(path.dirname(storageUri.fsPath), 'global-replacement')
    ),
    workspaceState: memento(),
    globalState: memento(),
    subscriptions
  });
  assert.equal(
    nextApi.getTimeline().status,
    'ready',
    'replacement activation owns existing history without IDE restart'
  );
  assert.equal(
    nextApi.getStoreRoot(),
    api.getStoreRoot(),
    'history binding preserved across replacement'
  );
  await fs.writeFile(path.join(root, 'after-upgrade.txt'), 'captured after hot upgrade');
  await nextApi.capture();
  assert.ok(nextApi.getTimeline().rows.at(-1).changedPaths.includes('after-upgrade.txt'));
  // Multi-checkpoint composition over the real host: two checkpoints with
  // disjoint deltas compose, apply and undo through the shared transaction.
  await fs.writeFile(path.join(root, 'multi-a.txt'), 'A v1');
  await nextApi.capture();
  const cpA = nextApi.head();
  await fs.writeFile(path.join(root, 'multi-b.txt'), 'B v1');
  await nextApi.capture();
  const cpB = nextApi.head();
  await fs.rm(path.join(root, 'multi-a.txt'));
  await fs.rm(path.join(root, 'multi-b.txt'));
  await nextApi.capture();
  const multi = await nextApi.reviewMulti([cpB, cpA], 'combine');
  assert.deepEqual(multi.conflicts ?? [], [], 'disjoint deltas compose cleanly');
  assert.ok(multi.compositionId, 'composition identity present');
  await nextApi.applyTarget(multi.target, multi.review.token, {
    kind: 'composed',
    mode: 'combine',
    sources: [cpB, cpA]
  });
  assert.equal(await fs.readFile(path.join(root, 'multi-a.txt'), 'utf8'), 'A v1');
  assert.equal(await fs.readFile(path.join(root, 'multi-b.txt'), 'utf8'), 'B v1');
  let appliedRow;
  const attrDeadline = Date.now() + 10000;
  do {
    await new Promise((r) => setTimeout(r, 250));
    appliedRow = nextApi.getTimeline().rows.find((r) => r.id === nextApi.head());
  } while (!appliedRow && Date.now() < attrDeadline);
  assert.equal(
    appliedRow && appliedRow.attribution.kind,
    'composed',
    'applied checkpoint carries composed attribution'
  );
  await nextApi.undo();
  await assert.rejects(fs.access(path.join(root, 'multi-a.txt')), 'undo removes A');
  await assert.rejects(fs.access(path.join(root, 'multi-b.txt')), 'undo removes B');
  // MCP review_checkpoints stays review-only in the host.
  const mcpConnection = await vscode.commands.executeCommand('scrubline.startMcp');
  const mcpConfig = JSON.parse(await fs.readFile(mcpConnection, 'utf8'));
  const mcpResponse = await fetch(mcpConfig.url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + mcpConfig.token },
    body: JSON.stringify({ name: 'review_checkpoints', checkpoints: [cpA], mode: 'combine' })
  });
  const mcpJson = await mcpResponse.json();
  assert.equal(mcpJson.status, 'pending_user_confirmation', 'MCP multi review never applies');
  await assert.rejects(fs.access(path.join(root, 'multi-a.txt')), 'MCP review wrote nothing');
  await vscode.commands.executeCommand('scrubline.openPanel');
  await replacement.deactivate();

  console.log(
    'HOST TEST PASS: activation, storage, edit, timeline, MCP review-only, restore/Undo, multi compose/apply/Undo, MCP multi review-only, panel command'
  );
};
