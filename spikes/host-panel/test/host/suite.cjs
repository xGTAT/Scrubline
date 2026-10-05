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
  await vscode.commands.executeCommand('scrubline.openPanel');
  console.log('HOST TEST PASS: activation, storage, edit, timeline, panel command');
};
