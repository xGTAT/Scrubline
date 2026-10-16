import type { ModuleGraph } from './types';

const IMPORT_FROM = /(?:import|export)\s[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT = /import\s*['"]([^'"]+)['"]/g;
const REQUIRE_CALL = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const MAX_NODES = 300;

function resolve(spec: string, fromPath: string, files: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = fromPath.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '.') continue;
    else if (part === '..') base.pop();
    else base.push(part);
  }
  const joined = base.join('/');
  const candidates = [joined, ...CODE_EXT.map((ext) => `${joined}${ext}`)];
  for (const ext of CODE_EXT) candidates.push(`${joined}/index${ext}`);
  for (const candidate of candidates) if (files.has(candidate)) return candidate;
  return null;
}

/**
 * Static import graph over checkpoint source. Edges are `from imports to`;
 * they describe file structure, never runtime call or data flow.
 */
export function buildImportGraph(files: { path: string; content: string }[]): ModuleGraph {
  const paths = new Set(files.map((f) => f.path));
  const edges: { from: string; to: string }[] = [];
  const external = new Set<string>();
  const nodes = new Set<string>();
  let truncated = false;
  for (const file of files) {
    if (nodes.size >= MAX_NODES) {
      truncated = true;
      break;
    }
    const specs: string[] = [];
    for (const pattern of [IMPORT_FROM, SIDE_EFFECT, REQUIRE_CALL]) {
      pattern.lastIndex = 0;
      for (const match of file.content.matchAll(pattern)) specs.push(match[1]);
    }
    for (const spec of specs) {
      const target = resolve(spec, file.path, paths);
      if (target) {
        if (target === file.path) continue;
        nodes.add(file.path);
        nodes.add(target);
        edges.push({ from: file.path, to: target });
      } else if (!spec.startsWith('.')) {
        external.add(
          spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        );
      }
    }
  }
  const key = (e: { from: string; to: string }) => `${e.from} -> ${e.to}`;
  const seen = new Set<string>();
  return {
    nodes: [...nodes].sort(),
    edges: edges.filter((e) => (seen.has(key(e)) ? false : (seen.add(key(e)), true))),
    external: [...external].sort(),
    scannedFiles: files.length,
    truncated
  };
}
