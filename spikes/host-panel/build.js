const esbuild = require('esbuild');
const path = require('path');

async function build() {
  console.log('[build] Bundling extension host...');
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
    bundle: true,
    outfile: path.join(__dirname, 'dist', 'extension.js'),
    external: ['vscode', 'playwright-core'],
    format: 'cjs',
    platform: 'node',
    sourcemap: false,
    minify: false
  });

  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'mcp', 'server.ts')],
    bundle: true,
    outfile: path.join(__dirname, 'dist', 'mcp.js'),
    format: 'cjs',
    platform: 'node',
    minify: true
  });

  console.log('[build] Bundling React webview UI...');
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'webview', 'index.tsx')],
    bundle: true,
    outfile: path.join(__dirname, 'dist', 'webview.js'),
    format: 'iife',
    platform: 'browser',
    sourcemap: false,
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  });

  console.log('[build] Build completed successfully into dist/');
}

build().catch((err) => {
  console.error('[build] Failed:', err);
  process.exit(1);
});
