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
