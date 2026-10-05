import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import * as path from 'node:path';
import { Timeline } from './capture/timeline';
import { HistoryStore, hashBytes } from './store/store';
import type { HostInfo } from './host-info';
import type { TimelineState, TimelineInbound } from './bridge/timeline';

export async function activate(context: vscode.ExtensionContext) {
  const hostInfo: HostInfo = {
    vscodeVersion: vscode.version,
    appName: vscode.env.appName,
    appHost: vscode.env.appHost,
    language: vscode.env.language,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    extensionPath: context.extensionPath
  };
  const views = new Set<vscode.Webview>();
  let state: TimelineState = {
    status: 'empty',
    rows: [],
    unsaved: false,
    message: 'Open a folder to begin.'
  };
  const publish = (next: TimelineState) => {
    state = next;
    for (const view of views) void view.postMessage({ type: 'timeline', data: state });
  };
  const folders = vscode.workspace.workspaceFolders ?? [];
  const config = vscode.workspace.getConfiguration('scrubline');
  let timeline: Timeline | undefined;
  const start = async () => {
    if (timeline || !folders.length) return;
    if (folders.length !== 1) {
      publish({ ...state, status: 'error', message: 'Open one workspace folder.' });
      return;
    }
    if (!vscode.workspace.isTrusted) {
      publish({ ...state, status: 'error', message: 'Trust this folder to capture.' });
      return;
    }
    if (folders[0].uri.scheme !== 'file') {
      publish({ ...state, status: 'error', message: 'Local folders only.' });
      return;
    }
    const root = folders[0].uri.fsPath;
    const storeRoot =
      context.storageUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, hashBytes(root));
    timeline = new Timeline(
      root,
      new HistoryStore(storeRoot, config.get<number>('quotaMB', 512) * 1024 * 1024),
      publish,
      {
        maxFiles: config.get<number>('maxFiles', 10000),
        maxFileBytes: config.get<number>('maxFileMB', 10) * 1024 * 1024,
        maxTotalBytes: config.get<number>('maxTotalMB', 100) * 1024 * 1024
      },
      config.get<string>('hookLog') || undefined
    );
    publish({ status: 'loading', rows: [], unsaved: false });
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folders[0], '**/*')
    );
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(() => timeline?.event('watcher')),
      watcher.onDidChange(() => timeline?.event('watcher')),
      watcher.onDidDelete(() => timeline?.event('watcher'))
    );
    const dirty = () =>
      timeline?.dirty(
        vscode.workspace.textDocuments.some(
          (d) =>
            d.isDirty &&
            vscode.workspace.getWorkspaceFolder(d.uri)?.uri.toString() === folders[0].uri.toString()
        )
      );
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(() => {
        dirty();
        timeline?.event('save');
      }),
      vscode.workspace.onDidChangeTextDocument(dirty),
      vscode.workspace.onDidCloseTextDocument(dirty),
      {
        dispose: () => {
          void timeline?.dispose();
        }
      }
    );
    await timeline.start();
    dirty();
  };
  const attach = (view: vscode.Webview) => {
    views.add(view);
    view.options = { enableScripts: true, localResourceRoots: [context.extensionUri] };
    view.html = getWebviewHtml(view, context.extensionUri, hostInfo);
    const listener = view.onDidReceiveMessage((message: TimelineInbound) => {
      if (message.type === 'request-timeline')
        void view.postMessage({ type: 'timeline', data: state });
      if (message.type === 'retry-capture') {
        if (timeline) void timeline.capture('reconcile');
        else void start();
      }
    });
    context.subscriptions.push(listener);
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'scrubline.historyView',
      {
        resolveWebviewView(view) {
          attach(view.webview);
          view.onDidDispose(() => views.delete(view.webview));
        }
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('scrubline.openPanel', () => {
      const panel = vscode.window.createWebviewPanel(
        'scrubline.panel',
        'Scrubline',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      attach(panel.webview);
      panel.onDidDispose(() => views.delete(panel.webview));
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void start())
  );
  await start();
  return { getTimeline: () => state, capture: () => timeline?.capture('reconcile') };
}
export function deactivate() {}

function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  hostInfo: HostInfo
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
  const nonce = randomBytes(16).toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Scrubline Panel</title>
  <style>
    body {
      padding: 0;
      margin: 0;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      color: var(--vscode-foreground, #cccccc);
      background-color: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e));
      font-size: var(--vscode-font-size, 13px);
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__SCRUBLINE_HOST_INFO__ = ${JSON.stringify(hostInfo).replace(/</g, '\\u003c')};
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
