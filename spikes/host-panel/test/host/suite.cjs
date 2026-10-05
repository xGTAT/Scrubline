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
  await new Promise((resolve) => setTimeout(resolve, 1200));
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
  const connection = await vscode.commands.executeCommand('scrubline.startMcp');
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
  await vscode.commands.executeCommand('scrubline.openPanel');
  console.log(
    'HOST TEST PASS: activation, storage, edit, timeline, MCP review-only, restore/Undo, panel command'
  );
};
