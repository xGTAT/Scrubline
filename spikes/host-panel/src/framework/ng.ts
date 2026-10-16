// Angular component template support. Angular templates are plain .html
// files referenced from @Component decorators via templateUrl, with paired
// styles via styleUrls/styleUrl. The template parses as HTML (directives
// like *ngFor, [binding] and (event) are attributes; {{ interpolation }} is
// masked like other expressions so byte offsets stay exact).
import * as path from 'node:path';
import { maskExpressions, indexTemplate } from './sfc';
import type { SourceIndex } from './types';

export function indexNgTemplate(file: string, code: string, stylesheets: string[]): SourceIndex {
  return {
    file,
    elements: indexTemplate(file, maskExpressions(code), 0),
    stylesheets,
    styleBlocks: [],
    cssInJs: false
  };
}

const safe = (p: string) =>
  p.length > 0 &&
  !p.includes('\\') &&
  !p.includes(':') &&
  !p.includes('\0') &&
  !p.startsWith('/') &&
  !p.split('/').includes('..');

/**
 * Find Angular component templates referenced by @Component decorators in a
 * TypeScript source. Returns template paths (posix, workspace-relative) with
 * the component's stylesheets re-relativized to the template's directory so
 * the shared stylesheet-pairing loop can resolve them. Inline `template:`
 * strings are out of scope (refused by omission: they are never matched).
 */
export function discoverNgTemplates(tsPath: string, code: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const dir = path.posix.dirname(tsPath);
  const styles: string[] = [];
  const urlsBlock = /styleUrls\s*:\s*\[([^\]]*)\]/.exec(code);
  const singleUrl = /styleUrl\s*:\s*['"`]([^'"`]+)['"`]/.exec(code);
  const rawStyles = urlsBlock
    ? [...urlsBlock[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1])
    : singleUrl
      ? [singleUrl[1]]
      : [];
  for (const s of rawStyles) {
    const abs = path.posix.normalize(path.posix.join(dir, s));
    if (safe(abs) && /\.(css|scss|less)$/.test(abs)) styles.push(abs);
  }
  for (const m of code.matchAll(/templateUrl\s*:\s*['"`]([^'"`]+)['"`]/g)) {
    const tpl = path.posix.normalize(path.posix.join(dir, m[1]));
    if (!safe(tpl) || !tpl.endsWith('.html')) continue;
    // Re-relativize styles from the template directory.
    const tplDir = path.posix.dirname(tpl);
    out.set(
      tpl,
      styles.map((s) => path.posix.relative(tplDir, s))
    );
  }
  return out;
}
