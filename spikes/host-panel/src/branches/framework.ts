import * as ts from 'typescript';
import * as path from 'node:path';
import { HistoryStore, hashBytes } from '../store/store';
import type { Checkpoint } from '../bridge/timeline';
import type { FiberSourceFrame } from './fiber-source';

// Framework element picking: React development builds only, mapped through
// dev-server source maps. Every structural doubt is a refusal, never a guess.

const SOURCE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];

// --- Source map decoding (VLQ), self-contained to avoid a runtime dependency.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64V = new Map([...B64].map((c, i) => [c, i]));
interface Segment {
  genCol: number;
  src?: number;
  origLine?: number;
  origCol?: number;
}
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let src = 0,
    origLine = 0,
    origCol = 0;
  for (const line of mappings.split(';')) {
    const segments: Segment[] = [];
    let genCol = 0;
    if (line)
      for (const segment of line.split(',')) {
        const values: number[] = [];
        let i = 0;
        while (i < segment.length) {
          let shift = 0,
            value = 0,
            digit: number;
          do {
            digit = B64V.get(segment[i++])!;
            if (digit === undefined) throw new Error('Invalid source map encoding.');
            value |= (digit & 31) << shift;
            shift += 5;
          } while (digit & 32);
          values.push(value & 1 ? -(value >> 1) : value >> 1);
        }
        genCol += values[0];
        if (values.length >= 4) {
          src += values[1];
          origLine += values[2];
          origCol += values[3];
          segments.push({ genCol, src, origLine, origCol });
        } else segments.push({ genCol });
      }
    lines.push(segments);
  }
  return lines;
}

/** Stack frames use 1-based lines and 1-based columns (V8). */
export function lookupOriginal(
  map: { mappings: string; sources: string[] },
  line: number,
  column: number
) {
  const segments = decodeMappings(map.mappings)[line - 1] ?? [];
  let best: Segment | undefined;
  for (const segment of segments) {
    if (segment.genCol <= column - 1) best = segment;
    else break;
  }
  if (!best || best.src === undefined) return undefined;
  return { source: map.sources[best.src], line: best.origLine! + 1, column: best.origCol! };
}

/**
 * Resolve a bundled-dev frame through its source map. Loopback URLs only:
 * the picker's preview server is local, and remote fetches are refused.
 */
export async function resolveViaSourceMap(
  frame: FiberSourceFrame
): Promise<{ source: string; line: number; column: number } | undefined> {
  let url: URL;
  try {
    url = new URL(frame.fileName);
  } catch {
    return undefined;
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Refusing to fetch source maps from a non-local URL.');
  const bundleText = await (await fetch(url)).text();
  const marker =
    bundleText.match(/\/\/# sourceMappingURL=(\S+)\s*$/m) ??
    bundleText.match(/\/\*# sourceMappingURL=(\S+)\s*\*\/\s*$/m);
  if (!marker) return undefined;
  const mapUrl = new URL(marker[1], url);
  if (mapUrl.origin !== url.origin) return undefined;
  const map = (await (await fetch(mapUrl)).json()) as { mappings: string; sources: string[] };
  const hit = lookupOriginal(map, frame.lineNumber, frame.columnNumber);
  if (!hit) return undefined;
  const relative = path.posix
    .normalize(path.posix.join(path.posix.dirname(mapUrl.pathname), hit.source))
    .replace(/^\/+/, '');
  return { source: relative, line: hit.line, column: hit.column + 1 };
}

// --- Source file resolution against tracked checkpoint files.

export function resolveTrackedSource(
  fileName: string,
  files: { path: string }[]
): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(fileName).pathname;
  } catch {
    pathname = fileName;
  }
  pathname = pathname.split('?')[0];
  if (!SOURCE_EXTENSIONS.some((e) => pathname.endsWith(e))) return undefined;
  const matches = files.filter((f) => pathname === f.path || pathname.endsWith('/' + f.path));
  if (matches.length !== 1) return undefined;
  return matches[0].path;
}

// --- JSX element location and identity (TypeScript parser).

export interface ElementIdentity {
  id?: string;
  key?: string;
  text: string;
}

export interface LocatedElement {
  start: number;
  end: number;
  text: string;
  tagName: string;
  componentName?: string;
  occurrenceIndex: number;
  skeleton: string[];
  /** Distinguishing signals used to disambiguate same-tag siblings. */
  identity: ElementIdentity;
}

function scriptKindFor(source: string) {
  if (/<[A-Za-z]/.test(source)) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function parseSource(source: string) {
  return ts.createSourceFile(
    'module.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(source)
  );
}

function tagOf(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return tag.getText();
}

function collectJsx(node: ts.Node, out: (ts.JsxElement | ts.JsxSelfClosingElement)[]) {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    out.push(node);
    if (ts.isJsxElement(node)) for (const c of node.children) collectJsx(c, out);
    return;
  }
  if (ts.isJsxFragment(node)) {
    for (const c of node.children) collectJsx(c, out);
    return;
  }
  node.forEachChild((c) => collectJsx(c, out));
}

function componentNameOf(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isClassDeclaration(current) && current.name) return current.name.text;
    if (ts.isVariableStatement(current)) {
      const decl = current.declarationList.declarations[0];
      if (decl && ts.isIdentifier(decl.name)) return decl.name.text;
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const parent: ts.Node | undefined = current.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
        return parent.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

/** Component body = the enclosing function/arrow/block that owns the JSX. */
function componentBodyOf(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current)
    )
      return current;
    current = current.parent;
  }
  return undefined;
}

function skeletonOf(body: ts.Node): string[] {
  const elements: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
  collectJsx(body, elements);
  return elements.map((e) => tagOf(e).toLowerCase());
}

function attrValue(el: ts.JsxElement | ts.JsxSelfClosingElement, name: string): string | undefined {
  const attrs = ts.isJsxElement(el) ? el.openingElement.attributes : el.attributes;
  for (const prop of attrs.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === name) {
      const init = prop.initializer;
      if (!init) return '';
      if (ts.isStringLiteral(init)) return init.text;
      return init
        .getText()
        .replace(/^\{|\}$/g, '')
        .trim();
    }
  }
  return undefined;
}

function ownText(el: ts.JsxElement | ts.JsxSelfClosingElement): string {
  if (!ts.isJsxElement(el)) return '';
  return el.children
    .filter(ts.isJsxText)
    .map((t) => t.getText())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function fingerprintOf(el: ts.JsxElement | ts.JsxSelfClosingElement): ElementIdentity {
  return { id: attrValue(el, 'id'), key: attrValue(el, 'key'), text: ownText(el) };
}

function locateIn(
  source: string,
  predicate: (el: ts.JsxElement | ts.JsxSelfClosingElement, pos: number) => boolean
): LocatedElement | undefined {
  const sf = parseSource(source);
  const elements: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
  collectJsx(sf, elements);
  const match = elements.find((el) => predicate(el, el.getStart(sf)));
  if (!match) return undefined;
  const body = componentBodyOf(match);
  if (!body) return undefined;
  const bodyElements: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
  collectJsx(body, bodyElements);
  const tag = tagOf(match);
  const sameTag = bodyElements.filter((e) => tagOf(e) === tag);
  return {
    start: match.getStart(sf),
    end: match.getEnd(),
    text: source.slice(match.getStart(sf), match.getEnd()),
    tagName: tag,
    componentName: componentNameOf(match),
    occurrenceIndex: sameTag.indexOf(match),
    skeleton: skeletonOf(body),
    identity: fingerprintOf(match)
  };
}

/** Find the JSX element whose opening tag starts at the 1-based line/column. */
export function extractJsxElement(
  source: string,
  line: number,
  column: number
): LocatedElement | undefined {
  const sf = parseSource(source);
  const target = ts.getPositionOfLineAndCharacter(sf, line - 1, column - 1);
  return locateIn(source, (el, start) => {
    const openingEnd = (ts.isJsxElement(el) ? el.openingElement : el).getEnd() ?? el.getEnd();
    return target >= start && target < openingEnd;
  });
}

/** Locate the corresponding element: same component, same tag, same skeleton. */
export function locateCorresponding(
  currentSource: string,
  historical: LocatedElement
): { range: { start: number; end: number } } | { refusal: string } {
  const sf = parseSource(currentSource);
  const elements: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
  collectJsx(sf, elements);
  const inComponent = elements.filter((el) => {
    if (historical.componentName) return componentNameOf(el) === historical.componentName;
    return componentNameOf(el) === undefined;
  });
  if (historical.componentName && !inComponent.length)
    return { refusal: `Component ${historical.componentName} no longer renders elements here.` };
  const candidateBodies = new Set<ts.Node>();
  for (const el of inComponent) {
    const body = componentBodyOf(el);
    if (body) candidateBodies.add(body);
  }
  if (candidateBodies.size !== 1)
    return { refusal: 'Component structure is ambiguous in current source.' };
  const body = [...candidateBodies][0];
  const skeleton = skeletonOf(body);
  if (JSON.stringify(skeleton) !== JSON.stringify(historical.skeleton))
    return {
      refusal:
        'Element structure changed between versions (reordered, moved or duplicated). Pick whole files instead.'
    };
  const bodyElements: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
  collectJsx(body, bodyElements);
  const sameTag = bodyElements.filter((e) => tagOf(e) === historical.tagName);
  const target = sameTag[historical.occurrenceIndex];
  if (!target) return { refusal: 'The element no longer exists in current source.' };
  // Position alone cannot tell an in-place edit from a same-tag sibling
  // reorder (the tag skeleton is unchanged by a swap). With more than one
  // same-tag sibling, require a shared distinguishing signal - id, key or
  // text - that still matches; anything else is a wrong-target risk.
  if (sameTag.length > 1) {
    const currentIdentity = fingerprintOf(target);
    // Strong stable signals first: when id (or key) exists on both sides it
    // decides identity, and a text difference is just the edit being
    // restored. Without id/key, equal text is the only signal left.
    const strong = (['id', 'key'] as const).find(
      (k) => historical.identity[k] !== undefined || currentIdentity[k] !== undefined
    );
    if (strong) {
      if (
        historical.identity[strong] === undefined ||
        currentIdentity[strong] === undefined ||
        historical.identity[strong] !== currentIdentity[strong]
      )
        return {
          refusal: `The element at this position no longer matches the picked element (${strong} differs). Same-tag siblings may have been reordered; refusing to guess. Pick whole files instead.`
        };
    } else if (!historical.identity.text || historical.identity.text !== currentIdentity.text) {
      return {
        refusal:
          'Same-tag siblings cannot be distinguished (no id or key, and the text at this position changed). The element may have been reordered or edited; refusing to guess. Pick whole files instead.'
      };
    }
  }
  return { range: { start: target.getStart(sf), end: target.getEnd() } };
}

// --- Semantic dependency guard.

/** Identifiers the copied subtree references (components, handlers, values). */
export function referencedIdentifiers(source: string, start: number, end: number): string[] {
  const sf = parseSource(source);
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    {
      const inside = node.getStart(sf) >= start && node.getEnd() <= end;
      if (inside && ts.isIdentifier(node)) {
        const parent = node.parent;
        const isPropertyName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isJsxAttribute(parent) && parent.name === node) ||
          (ts.isMethodSignature(parent) && parent.name === node);
        const isJsxTagName =
          (ts.isJsxOpeningElement(parent) ||
            ts.isJsxClosingElement(parent) ||
            ts.isJsxSelfClosingElement(parent)) &&
          /^[a-z]/.test(node.text);
        if (!isPropertyName && !isJsxTagName) names.add(node.text);
      }
    }
    node.forEachChild(visit);
  };
  ts.forEachChild(sf, visit);
  return [...names].sort();
}

/** Identifiers available to the component in the current file. */
export function availableIdentifiers(
  source: string,
  componentName: string | undefined
): Set<string> {
  const sf = parseSource(source);
  const names = new Set<string>(['React']);
  const addPattern = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else
      name.elements.forEach((el) => {
        if (ts.isBindingElement(el)) addPattern(el.name);
      });
  };
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.name) names.add(clause.name.text);
      const named = clause.namedBindings;
      if (named) {
        if (ts.isNamespaceImport(named)) names.add(named.name.text);
        else named.elements.forEach((el) => names.add(el.name.text));
      }
    } else if (ts.isVariableStatement(statement)) {
      statement.declarationList.declarations.forEach((d) => addPattern(d.name));
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    }
  }
  // Declarations inside the component body (hooks results, locals, params).
  const elements: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
  collectJsx(sf, elements);
  const body = componentBodyOf(
    elements.find((el) =>
      componentName ? componentNameOf(el) === componentName : componentNameOf(el) === undefined
    ) ?? sf
  );
  const target = body ?? sf;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) addPattern(node.name);
    if (ts.isFunctionDeclaration(node) && node.name) names.add(node.name.text);
    if (ts.isBindingElement(node)) addPattern(node.name);
    node.forEachChild(visit);
  };
  visit(target);
  return names;
}

// --- Candidate construction.

async function writeBlob(store: HistoryStore, text: string) {
  const bytes = Buffer.from(text);
  const hash = hashBytes(bytes);
  await store.putBlob(hash, bytes);
  return { hash, size: bytes.length };
}

export interface FrameworkPick {
  /** First user-space frame from fiber metadata. */
  frame: FiberSourceFrame;
  /** Clicked element tag (lowercase). */
  tag: string;
  /** Original source position after source-map resolution, when bundled. */
  resolved?: { source: string; line: number; column: number };
}

/**
 * Build a candidate checkpoint restoring one JSX element on a framework page.
 * Throws with an explanatory message on every ambiguity - the caller offers
 * the whole-file fallback.
 */
export async function frameworkElementCandidate(
  store: HistoryStore,
  source: Checkpoint,
  current: Checkpoint,
  pick: FrameworkPick
) {
  const file = resolveTrackedSource(pick.resolved?.source ?? pick.frame.fileName, source.files);
  if (!file)
    throw new Error(
      'The page source file is not tracked in this checkpoint. Pick whole files instead.'
    );
  if (!current.files.some((f) => f.path === file))
    throw new Error(`${file} does not exist in the current checkpoint. Pick whole files instead.`);
  const line = pick.resolved?.line ?? pick.frame.lineNumber;
  const column = pick.resolved?.column ?? pick.frame.columnNumber;
  const historicalText = (
    await store.readBlob(source.files.find((f) => f.path === file)!.hash)
  ).toString('utf8');
  const historical = extractJsxElement(historicalText, line, column);
  if (!historical)
    throw new Error(
      'No JSX element found at the mapped source position. Pick whole files instead.'
    );
  if (historical.tagName.toLowerCase() !== pick.tag.toLowerCase())
    throw new Error(
      `Mapped source is a <${historical.tagName}> but you clicked a <${pick.tag}>. Source map mismatch; pick whole files instead.`
    );
  const currentText = (
    await store.readBlob(current.files.find((f) => f.path === file)!.hash)
  ).toString('utf8');
  const located = locateCorresponding(currentText, historical);
  if ('refusal' in located) throw new Error(located.refusal);
  const currentSlice = currentText.slice(located.range.start, located.range.end);
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (normalize(currentSlice) === normalize(historical.text))
    throw new Error('The element already matches this checkpoint.');
  const needed = referencedIdentifiers(historicalText, historical.start, historical.end);
  const available = availableIdentifiers(currentText, historical.componentName);
  const missing = needed.filter((n) => !available.has(n));
  if (missing.length)
    throw new Error(
      `The element depends on ${missing.join(', ')}, which current source no longer provides. Pick whole files instead.`
    );
  const nextText =
    currentText.slice(0, located.range.start) +
    historical.text +
    currentText.slice(located.range.end);
  const { hash, size } = await writeBlob(store, nextText);
  const files = current.files.map((f) => (f.path === file ? { ...f, hash, size } : { ...f }));
  const { id: _id, ...body } = current;
  void _id;
  const candidate = { ...body, files };
  return {
    checkpoint: { ...candidate, id: hashBytes(JSON.stringify(candidate)) },
    file,
    referenced: needed
  };
}
