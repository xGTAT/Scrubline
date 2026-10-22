// Framework element candidate: selective restore of one element inside a
// framework source file (JSX/TSX, Vue/Astro/Svelte template), plus paired
// exclusive styles from imported stylesheets (.css/.scss/.less) or SFC
// <style> blocks. Mirrors the safety posture of branches/element.ts:
// unique match or refusal, shared styles stay current.
import * as path from 'node:path';
import postcss from 'postcss';
import postcssScss from 'postcss-scss';
import postcssLess from 'postcss-less';
import { HistoryStore, hashBytes, safePath } from '../store/store';
import type { Checkpoint } from '../bridge/timeline';
import { indexJsx } from './jsx';
import { indexSfc } from './sfc';
import { discoverNgTemplates, indexNgTemplate } from './ng';
import { matchPicked, mapIdentity } from './match';
import { ownedBySubtree } from './selectors';
import {
  FRAMEWORK_EXTENSIONS,
  SCRIPT_EXTENSIONS,
  type PickInfo,
  type SourceElement,
  type SourceIndex
} from './types';

const MAX_INDEX_BYTES = 512 * 1024;

function indexFile(file: string, text: string): SourceIndex {
  const lower = file.toLowerCase();
  if (lower.endsWith('.vue') || lower.endsWith('.svelte') || lower.endsWith('.astro'))
    return indexSfc(file, text);
  return indexJsx(file, text);
}

function syntaxFor(name: string): { parse: (css: string) => postcss.Root } {
  if (name.endsWith('.scss'))
    return postcssScss as unknown as { parse: (css: string) => postcss.Root };
  if (name.endsWith('.less'))
    return postcssLess as unknown as { parse: (css: string) => postcss.Root };
  return postcss;
}

function split(root: postcss.Root, elements: SourceElement[], selected: SourceElement) {
  const owned: postcss.Rule[] = [];
  root.walkRules((rule) => {
    let parent = rule.parent;
    while (parent && parent.type !== 'root') {
      if (
        parent.type !== 'atrule' ||
        !['media', 'supports', 'container', 'layer'].includes(parent.name.toLowerCase())
      )
        return;
      parent = parent.parent;
    }
    if (ownedBySubtree(rule.selector, elements, selected) === true) owned.push(rule);
  });
  const key = (r: postcss.Rule) => {
    const parents: string[] = [];
    let p = r.parent;
    while (p && p.type !== 'root') {
      if (p.type === 'atrule') parents.unshift('@' + p.name + ' ' + p.params);
      p = p.parent;
    }
    return JSON.stringify([...parents, r.selector]);
  };
  return { owned, keys: owned.map(key), key };
}

// Replace owned rules in `after` with their `before` clones, same pairing
// rule as the static HTML path: exactly one rule with the same key on both sides.
function pairOwnedRules(
  beforeCss: string,
  afterCss: string,
  syntax: { parse: (css: string) => postcss.Root },
  beforeElements: SourceElement[],
  afterElements: SourceElement[],
  selectedBefore: SourceElement,
  selectedAfter: SourceElement
): string {
  const before = syntax.parse(beforeCss);
  const after = syntax.parse(afterCss);
  const a = split(before, beforeElements, selectedBefore);
  const b = split(after, afterElements, selectedAfter);
  for (let i = 0; i < b.owned.length; i++) {
    const key = b.keys[i];
    const oldRules = a.owned.filter((r) => a.key(r) === key);
    const newRules = b.owned.filter((r) => b.key(r) === key);
    if (oldRules.length === 1 && newRules.length === 1) b.owned[i].replaceWith(oldRules[0].clone());
  }
  return after.toString();
}

export interface FrameworkCandidateResult {
  candidate: Checkpoint;
  notes: string[];
}

export async function frameworkElementCandidate(
  store: HistoryStore,
  source: Checkpoint,
  current: Checkpoint,
  pick: PickInfo,
  opts: { document?: string } = {}
): Promise<FrameworkCandidateResult> {
  const notes: string[] = [];
  const read = async (cp: Checkpoint, p: string) => {
    const f = cp.files.find((f) => f.path === p);
    if (!f) throw new Error('Source file unavailable.');
    return (await store.readBlob(f.hash)).toString('utf8');
  };
  // Framework source files tracked in both versions.
  const currentPaths = new Set(current.files.map((f) => f.path));
  const sourcePaths = new Set(source.files.map((f) => f.path));
  let files = source.files
    .map((f) => f.path)
    .filter(
      (p) =>
        SCRIPT_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext)) &&
        currentPaths.has(p) &&
        sourcePaths.has(p)
    );
  if (opts.document) {
    if (!safePath(opts.document)) throw new Error('Unsafe document path.');
    files = files.filter((p) => p === opts.document);
    if (!files.length) throw new Error('Document not tracked in both versions.');
  }
  // Angular component templates: .html files referenced via templateUrl from
  // a tracked TypeScript component, tracked in both versions. Static HTML
  // documents are never indexed here - they stay on the exact element path.
  const ngStyles = new Map<string, string[]>();
  if (!opts.document) {
    for (const f of source.files) {
      if (!f.path.endsWith('.ts') || !currentPaths.has(f.path)) continue;
      let tsText: string;
      try {
        tsText = await read(source, f.path);
      } catch {
        continue;
      }
      if (tsText.length > MAX_INDEX_BYTES || !tsText.includes('templateUrl')) continue;
      for (const [tpl, styles] of discoverNgTemplates(f.path, tsText)) {
        if (currentPaths.has(tpl) && sourcePaths.has(tpl) && !files.includes(tpl)) {
          files.push(tpl);
          ngStyles.set(tpl, styles);
        }
      }
    }
  }

  const indexer = (file: string, text: string): SourceIndex =>
    ngStyles.has(file) ? indexNgTemplate(file, text, ngStyles.get(file)!) : indexFile(file, text);

  const oldIndexes: SourceIndex[] = [];
  const nowIndexes = new Map<string, SourceIndex>();
  const texts = new Map<string, { oldText: string; nowText: string }>();
  for (const file of files) {
    const [oldText, nowText] = await Promise.all([read(source, file), read(current, file)]);
    if (oldText.length > MAX_INDEX_BYTES || nowText.length > MAX_INDEX_BYTES) continue;
    try {
      oldIndexes.push(indexer(file, oldText));
      nowIndexes.set(file, indexer(file, nowText));
      texts.set(file, { oldText, nowText });
    } catch {
      if (opts.document) throw new Error(`Could not parse ${file}. Review the whole file instead.`);
      // Unparseable files are skipped, never guessed at.
    }
  }
  const selected = matchPicked(oldIndexes, pick);
  const file = selected.file;
  if (ngStyles.has(file))
    notes.push(
      'Angular component template: markup restored; component logic and non-owned styles stay current. Inline template: strings are not supported.'
    );
  const oldIdx = oldIndexes.find((i) => i.file === file)!;
  const nowIdx = nowIndexes.get(file)!;
  const { oldText, nowText } = texts.get(file)!;
  const nowEl = mapIdentity(selected, oldIdx, nowIdx);
  if (oldIdx.cssInJs || nowIdx.cssInJs)
    notes.push(
      'CSS-in-JS detected (styled-components/emotion). Only markup and inline styles are restored; component-defined styles stay current.'
    );

  // Splice: style block edits and the element range edit both target nowText
  // offsets, so apply them highest-offset first.
  const splices: { start: number; end: number; text: string }[] = [];
  const combinedOld = oldIndexes.flatMap((i) => i.elements);
  const combinedNow = [...nowIndexes.values()].flatMap((i) => i.elements);

  if (!oldIdx.cssInJs && !nowIdx.cssInJs) {
    if (oldIdx.styleBlocks.length || nowIdx.styleBlocks.length) {
      // SFC style blocks, same file only.
      if (oldIdx.styleBlocks.length !== nowIdx.styleBlocks.length)
        throw new Error('Style block list changed. Element ownership unresolved.');
      for (let i = 0; i < oldIdx.styleBlocks.length; i++) {
        const beforeCss = oldText.slice(
          oldIdx.styleBlocks[i].contentStart,
          oldIdx.styleBlocks[i].contentEnd
        );
        const nb = nowIdx.styleBlocks[i];
        const afterCss = nowText.slice(nb.contentStart, nb.contentEnd);
        const lang = oldText.slice(oldIdx.styleBlocks[i].start, oldIdx.styleBlocks[i].contentStart);
        const syntax = syntaxFor(
          lang.includes('scss') ? '.scss' : lang.includes('less') ? '.less' : '.css'
        );
        const replaced = pairOwnedRules(
          beforeCss,
          afterCss,
          syntax,
          oldIdx.elements,
          nowIdx.elements,
          selected,
          nowEl
        );
        if (replaced !== afterCss)
          splices.push({ start: nb.contentStart, end: nb.contentEnd, text: replaced });
      }
    }
    // Imported stylesheets (JSX/TS path). Require an unchanged import list.
    if (JSON.stringify(oldIdx.stylesheets) !== JSON.stringify(nowIdx.stylesheets))
      throw new Error('Stylesheet list changed. Element ownership unresolved.');
    for (const href of oldIdx.stylesheets) {
      const p = path.posix.join(path.posix.dirname(file), href);
      if (!safePath(p) || !/\.(css|scss|less)$/.test(p)) throw new Error('Unsafe stylesheet.');
      const [beforeCss, afterCss] = await Promise.all([read(source, p), read(current, p)]);
      const replaced = pairOwnedRules(
        beforeCss,
        afterCss,
        syntaxFor(p),
        combinedOld,
        combinedNow,
        selected,
        nowEl
      );
      if (replaced !== afterCss) texts.set(p, { oldText: beforeCss, nowText: replaced });
    }
  }

  splices.push({
    start: nowEl.start,
    end: nowEl.end,
    text: oldText.slice(selected.start, selected.end)
  });
  splices.sort((a, b) => b.start - a.start);
  let newText = nowText;
  for (const s of splices) newText = newText.slice(0, s.start) + s.text + newText.slice(s.end);
  // Post-edit sanity: the mapped identity must still resolve uniquely.
  const recheck = indexer(file, newText);
  const mapped = mapIdentity(selected, oldIdx, recheck);
  if (newText.slice(mapped.start, mapped.end) !== oldText.slice(selected.start, selected.end))
    throw new Error('Post-edit mapping changed. Nothing applied.');

  const changes = new Map<string, string>();
  changes.set(file, newText);
  for (const [p, t] of texts) {
    if (p !== file && t.nowText !== (await read(current, p))) changes.set(p, t.nowText);
  }

  const outFiles = current.files.map((f) => ({ ...f }));
  for (const [p, text] of changes) {
    const f = outFiles.find((f) => f.path === p)!;
    const bytes = Buffer.from(text);
    f.hash = hashBytes(bytes);
    f.size = bytes.length;
    await store.putBlob(f.hash, bytes);
  }
  const { id: _id, ...body } = current;
  void _id;
  const candidate = { ...body, files: outFiles };
  return { candidate: { ...candidate, id: hashBytes(JSON.stringify(candidate)) }, notes };
}

export function isFrameworkDocument(p: string): boolean {
  return FRAMEWORK_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext));
}
