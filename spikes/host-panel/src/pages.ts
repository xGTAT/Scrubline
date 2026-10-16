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
  return pages;
}

/**
 * Element cherry-picking needs the page's document as a tracked static HTML
 * file in the checkpoint. Framework or server-rendered routes lack one.
 */
export function isPickableDocument(document: string, files: { path: string }[]) {
  return document.endsWith('.html') && files.some((f) => f.path === document);
}

const REFERENCE_ATTRIBUTES = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
const SRCSET_ATTRIBUTE = /\bsrcset\s*=\s*["']([^"']+)["']/gi;
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
  for (const match of html.matchAll(REFERENCE_ATTRIBUTES)) references.push(match[1]);
  for (const match of html.matchAll(SRCSET_ATTRIBUTE))
    for (const candidate of match[1].split(',')) {
      const url = candidate.trim().split(/\s+/, 1)[0];
      if (url) references.push(url);
    }
  return references;
}

function cssReferences(css: string) {
  const references: string[] = [];
  for (const match of css.matchAll(CSS_REFERENCES)) references.push(match[1] ?? match[2]);
  return references;
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
    const references = file.endsWith('.html')
      ? htmlReferences(content)
      : file.endsWith('.css')
        ? cssReferences(content)
        : [];
    for (const reference of references) {
      const resolved = resolveReference(file, reference);
      if (resolved) pending.push(resolved);
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
