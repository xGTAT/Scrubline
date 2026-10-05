// Minimal static server for the webview harness: serves dist/ and an inline
// HTML shell that stubs __SCRUBLINE_HOST_INFO__ exactly like the extension host.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // spikes/host-panel
const PORT = Number(process.env.HARNESS_PORT || 4701);

const MIME = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml'
};

const HOST_INFO = {
  vscodeVersion: '1.139.1',
  appName: 'Scrubline Harness',
  appHost: 'harness',
  language: 'en',
  workspaceFolders: [],
  extensionPath: '/harness'
};

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Scrubline Panel Harness</title>
<link rel="stylesheet" href="/dist/webview.css">
<style>
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
         color: var(--vscode-foreground, #cccccc);
         background: var(--vscode-sideBar-background, #1e1e1e);
         font-size: var(--vscode-font-size, 13px); }
</style>
</head>
<body>
<div id="root"></div>
<script>window.__SCRUBLINE_HOST_INFO__ = ${JSON.stringify(HOST_INFO)};</script>
<script src="/dist/webview.js"></script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(SHELL);
      return;
    }
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^([/\\])+/, '');
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, () => console.log(`harness on :${PORT}`));
