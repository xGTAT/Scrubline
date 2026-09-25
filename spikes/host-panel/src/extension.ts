import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
  const hostInfo = {
    vscodeVersion: vscode.version,
    appName: vscode.env.appName,
    appHost: vscode.env.appHost,
    language: vscode.env.language,
    shell: vscode.env.shell,
    workspaceFolders: (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath),
    extensionPath: context.extensionPath
  };

  console.log('[Scrubline Host Panel] Activated in host:', hostInfo);

  // 1. Register Webview View Provider (Sidebar)
  const provider = new ScrublineViewProvider(context.extensionUri, hostInfo);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('scrubline.historyView', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // 2. Register Command to open Webview Panel (Editor tab)
  context.subscriptions.push(
    vscode.commands.registerCommand('scrubline.openPanel', () => {
      const panel = vscode.window.createWebviewPanel(
        'scrubline.panel',
        'Scrubline Review Panel',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [context.extensionUri]
        }
      );

      panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri, hostInfo);

      panel.webview.onDidReceiveMessage(message => {
        if (message.type === 'request-host-info') {
          panel.webview.postMessage({
            type: 'host-info',
            data: hostInfo
          });
        }
      });
    })
  );
}

export function deactivate() {}

class ScrublineViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _hostInfo: any
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = getWebviewHtml(webviewView.webview, this._extensionUri, this._hostInfo);

    webviewView.webview.onDidReceiveMessage(message => {
      if (message.type === 'request-host-info') {
        webviewView.webview.postMessage({
          type: 'host-info',
          data: this._hostInfo
        });
      }
    });
  }
}

function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, hostInfo: any): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <title>Scrubline Panel</title>
  <style>
    body {
      padding: 0;
      margin: 0;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      color: var(--vscode-foreground, #cccccc);
      background-color: var(--vscode-editor-background, #1e1e1e);
      font-size: var(--vscode-font-size, 13px);
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__SCRUBLINE_HOST_INFO__ = ${JSON.stringify(hostInfo)};
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
