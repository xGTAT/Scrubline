import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface PageInfo {
  /** Local route used for preview, always starting with '/'. */
  route: string;
  /** Workspace-relative HTML document path used for element mapping. */
  document: string;
}

const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage']);
const MAX_PAGES = 200;
const MAX_DEPTH = 8;

/** Route for a workspace-relative HTML document, mirroring the preview server mapping. */
export function documentToRoute(document: string) {
  return document === 'index.html' ? '/' : `/${document}`;
}

/** Document for a local route, mirroring extension pick-element mapping. */
export function routeToDocument(route: string) {
  return route === '/' ? 'index.html' : route.replace(/^\//, '');
}

/**
 * List previewable static HTML pages in the workspace. Root index.html is '/'
 * and sorts first. Directories that never hold authored pages are skipped.
 */
export async function listPages(root: string): Promise<PageInfo[]> {
  const pages: PageInfo[] = [];
  const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (pages.length >= MAX_PAGES || depth > MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (pages.length >= MAX_PAGES) return;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(path.join(directory, entry.name), childRelative, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        pages.push({ route: documentToRoute(childRelative), document: childRelative });
      }
    }
  };
  await walk(root, '', 0);
  pages.sort((a, b) =>
    a.route === '/' ? -1 : b.route === '/' ? 1 : a.document.localeCompare(b.document)
  );
  return [...pages, ...(await listFrameworkPages(root, pages))];
}

const COMPONENT_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.astro']);
const MODULE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  '.css',
  '.scss',
  '.less',
  '.json',
  '.md',
  '.mdx'
];
/** Test, story, declaration and mock modules are never user-facing pages. */
const NON_PAGE_MODULE = /(?:\.d\.ts$|__tests__|__mocks__|\.(?:test|spec|stories|story)\.[jt]sx?$)/i;

/** Route for a file-based routing module, or undefined when the file is not a route. */
function fileBasedRoute(document: string): string | undefined {
  const ext = path.posix.extname(document);
  const base = document.slice(0, document.length - ext.length);
  const segments = base.split('/');
  const name = segments[segments.length - 1];
  const routeOf = (parts: string[]) => {
    const last = parts[parts.length - 1];
    const trimmed =
      last === 'index' || last === '_index' || last === '+page' || last === 'page'
        ? parts.slice(0, -1)
        : parts;
    return '/' + trimmed.join('/');
  };
  // Next.js pages router / Nuxt: pages/** or src/pages/** (api and _-files excluded).
  for (const prefix of ['pages/', 'src/pages/']) {
    if (document.startsWith(prefix)) {
      const rest = document.slice(prefix.length);
      if (rest.startsWith('api/') || rest.split('/').some((s) => s.startsWith('_')))
        return undefined;
      if (['.js', '.jsx', '.ts', '.tsx', '.vue'].includes(ext))
        return routeOf(rest.slice(0, rest.length - ext.length).split('/'));
      if (['.astro', '.md', '.mdx'].includes(ext) && prefix === 'src/pages/')
        return routeOf(rest.slice(0, rest.length - ext.length).split('/'));
      return undefined;
    }
  }
  // Next.js app router: app/**/page.* or src/app/**/page.*.
  for (const prefix of ['app/', 'src/app/']) {
    if (document.startsWith(prefix) && /^page\.[jt]sx?$/.test(name + ext)) {
      if (!['.js', '.jsx', '.ts', '.tsx'].includes(ext)) return undefined;
      return routeOf(base.slice(prefix.length).split('/'));
    }
  }
  // SvelteKit: src/routes/**/+page.svelte.
  if (document.startsWith('src/routes/') && name === '+page' && ext === '.svelte')
    return routeOf(base.slice('src/routes/'.length).split('/'));
  // Qwik City / SolidStart: src/routes/**/index.{jsx,tsx}.
  if (document.startsWith('src/routes/') && name === 'index' && ['.jsx', '.tsx'].includes(ext))
    return routeOf(base.slice('src/routes/'.length).split('/'));
  // Remix flat routes: app/routes/** (dots nest, $param is dynamic).
  if (document.startsWith('app/routes/') && ['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
    const flat = base
      .slice('app/routes/'.length)
      .split('/')
      .map((part) => part.replace(/\$/g, ':').replace(/\./g, '/'));
    return routeOf(flat.join('/').split('/'));
  }
  return undefined;
}

/** True for authored component modules surfaced as scrubbable pages. */
function isComponentModule(document: string): boolean {
  if (NON_PAGE_MODULE.test(document)) return false;
  if (document.endsWith('.component.ts')) return true;
  return COMPONENT_EXTENSIONS.has(path.posix.extname(document));
}

/**
 * Framework pages: file-based routes (Next.js, Nuxt, SvelteKit, Astro, Remix,
 * Qwik City, SolidStart) get their own URL route. Component modules of
 * client-rendered apps (React, Vue, Svelte, Solid, Preact, Angular) are
 * surfaced with the app's root route so their changes scrub independently.
 * Routes that exist only in code (React Router and similar) are still not
 * detected; add them with Add page route….
 */
async function listFrameworkPages(root: string, existing: PageInfo[]): Promise<PageInfo[]> {
  const pages: PageInfo[] = [];
  const seenDocuments = new Set(existing.map((p) => p.document));
  const seenRoutes = new Set(existing.map((p) => p.route));
  const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
    if (pages.length + existing.length >= MAX_PAGES || depth > MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (pages.length + existing.length >= MAX_PAGES) return;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        await visit(path.join(directory, entry.name), childRelative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const route = fileBasedRoute(childRelative);
      if (route !== undefined) {
        if (!seenDocuments.has(childRelative) && !seenRoutes.has(route)) {
          seenDocuments.add(childRelative);
          pages.push({ route, document: childRelative });
        }
        continue;
      }
      if (
        childRelative.startsWith('src/') &&
        isComponentModule(childRelative) &&
        !seenDocuments.has(childRelative)
      ) {
        seenDocuments.add(childRelative);
        pages.push({ route: '/', document: childRelative });
      }
    }
  };
  await visit(root, '', 0);
  pages.sort((a, b) => a.document.localeCompare(b.document));
  return pages;
}

/**
 * Element cherry-picking needs the page's document as a tracked static HTML
 * file in the checkpoint. Framework or server-rendered routes lack one.
 */
export function isPickableDocument(document: string, files: { path: string }[]) {
  return document.endsWith('.html') && files.some((f) => f.path === document);
}

// Only asset-carrying tags count as dependencies: a navigation <a href> to
// another page must not merge that page (and its assets) into this page's set.
const ASSET_TAGS = /<(link|script|img|source|video|audio|iframe)\b[^>]*>/gi;
const TAG_REFERENCES = /\b(?:href|src|srcset)\s*=\s*["']([^"']+)["']/gi;
const CSS_REFERENCES =
  /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?|url\(\s*["']?([^"')]+)["']?\s*\)/gi;
const MAX_PAGE_FILES = 500;

/** True when a reference points outside the workspace's local files. */
function isExternalReference(reference: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference);
}

/** Workspace-relative path for a local reference, or undefined when it escapes the root. */
function resolveReference(fromFile: string, reference: string) {
  const clean = reference.split(/[?#]/, 1)[0].trim();
  if (!clean || isExternalReference(clean)) return undefined;
  const joined = clean.startsWith('/')
    ? clean.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean));
  if (joined.startsWith('../') || joined === '..' || path.posix.isAbsolute(joined))
    return undefined;
  return joined;
}

function htmlReferences(html: string) {
  const references: string[] = [];
  for (const tag of html.matchAll(ASSET_TAGS))
    for (const match of tag[0].matchAll(TAG_REFERENCES)) {
      if (match[0].toLowerCase().startsWith('srcset'))
        for (const candidate of match[1].split(',')) {
          const url = candidate.trim().split(/\s+/, 1)[0];
          if (url) references.push(url);
        }
      else references.push(match[1]);
    }
  return references;
}

function cssReferences(css: string) {
  const references: string[] = [];
  for (const match of css.matchAll(CSS_REFERENCES)) references.push(match[1] ?? match[2]);
  return references;
}

const MODULE_REFERENCES =
  /(?:import|export)\s[^'"]*?\sfrom\s*["']([^"']+)["']|(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;

/** Bare package specifiers are not workspace files. */
function isLocalModuleReference(reference: string) {
  return (
    reference.startsWith('./') ||
    reference.startsWith('../') ||
    reference.startsWith('/') ||
    reference.startsWith('@/') ||
    reference.startsWith('~/')
  );
}

/**
 * Local files a JS/TS-family module imports. Path aliases @/ and ~/ resolve
 * against src/, matching the common Vite/Next/Angular tsconfig mapping.
 */
function moduleReferences(source: string) {
  const references: string[] = [];
  for (const match of source.matchAll(MODULE_REFERENCES)) {
    const reference = match[1] ?? match[2] ?? match[3];
    if (reference && isLocalModuleReference(reference)) references.push(reference);
  }
  return references;
}

/** Existing workspace file for an extensionless or aliased module specifier. */
async function resolveModuleReference(root: string, fromFile: string, reference: string) {
  let candidate: string | undefined;
  if (reference.startsWith('@/') || reference.startsWith('~/'))
    candidate = path.posix.normalize(`src/${reference.slice(2)}`);
  else candidate = resolveReference(fromFile, reference);
  if (!candidate) return undefined;
  const exists = async (file: string) => {
    try {
      return (await fs.stat(path.join(root, file))).isFile();
    } catch {
      return false;
    }
  };
  if (path.posix.extname(candidate)) return candidate;
  for (const ext of MODULE_EXTENSIONS) {
    if (await exists(candidate + ext)) return candidate + ext;
  }
  for (const ext of MODULE_EXTENSIONS) {
    if (await exists(`${candidate}/index${ext}`)) return `${candidate}/index${ext}`;
  }
  return candidate;
}

/**
 * Local workspace files a page depends on: its HTML document plus every local
 * asset the document references (stylesheets, scripts, images, media), and
 * recursively the local @import/url() targets of those stylesheets. Missing
 * files stay listed so creating them later still counts as a page change.
 * Server-rendered routes without a static document resolve to an empty set,
 * which callers must treat as "cannot prove irrelevance".
 */
export async function pageFiles(root: string, document: string): Promise<Set<string>> {
  const files = new Set<string>();
  const pending: string[] = [];
  const visit = async (file: string) => {
    if (files.size >= MAX_PAGE_FILES || files.has(file)) return;
    files.add(file);
    let content: string;
    try {
      if ((await fs.stat(path.join(root, file))).size > 1024 * 1024) return;
      content = await fs.readFile(path.join(root, file), 'utf8');
    } catch {
      return; // Missing or unreadable file; the path still identifies the dependency.
    }
    const ext = path.posix.extname(file);
    if (file.endsWith('.html')) {
      for (const reference of htmlReferences(content)) {
        const resolved = resolveReference(file, reference);
        if (resolved) pending.push(resolved);
      }
    } else if (ext === '.css' || ext === '.scss' || ext === '.less') {
      for (const reference of cssReferences(content)) {
        const resolved = resolveReference(file, reference);
        if (resolved) pending.push(resolved);
      }
    } else if (MODULE_EXTENSIONS.includes(ext)) {
      for (const reference of moduleReferences(content)) {
        const resolved = await resolveModuleReference(root, file, reference);
        if (resolved) pending.push(resolved);
      }
    }
  };
  await visit(document);
  while (pending.length && files.size < MAX_PAGE_FILES) await visit(pending.shift()!);
  return files;
}

/**
 * Whether a checkpoint row belongs on a page. A row is hidden only when its
 * changed paths provably belong to a different page: they touch no file this
 * page depends on, but do touch a file some known page depends on. Rows that
 * touch no mapped page file at all stay visible everywhere, and pages without
 * a mapped document (server routes) keep every row.
 */
export function rowRelevantToPage(
  changed: string[],
  ownFiles: Set<string>,
  allPageFiles: Set<string>
) {
  if (!ownFiles.size) return true;
  if (changed.some((file) => ownFiles.has(file))) return true;
  return !changed.some((file) => allPageFiles.has(file));
}
