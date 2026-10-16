// Minimal, conservative CSS selector matching against indexed source elements.
// Supports comma lists, descendant/child combinators, tag, .class and #id.
// Anything else (attribute selectors, pseudo logic beyond the same safe
// stripping the HTML path uses) parses to null: the rule is never owned,
// never rolled back.
import type { SourceElement } from './types';

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
}
interface ComplexSelector {
  // Right-to-left: parts[0] is the subject.
  parts: { combinator: ' ' | '>'; compound: Compound }[];
  subject: Compound;
}

const DYNAMIC_PSEUDO =
  /:(?:not|is|where|has)\([^)]*:(?:hover|focus|active|visited|checked|disabled|enabled|target)/;
const STRIP_PSEUDO =
  /:(?:hover|active|focus-visible|focus-within|focus|visited|link|checked|disabled|enabled|target)\b/g;

export function parseSelectorList(selector: string): ComplexSelector[] | null {
  if (DYNAMIC_PSEUDO.test(selector)) return null;
  const cleaned = selector.replace(/::[\w-]+(?:\([^)]*\))?/g, '').replace(STRIP_PSEUDO, '');
  if (cleaned.includes(':') || cleaned.includes('[') || cleaned.includes('*')) return null;
  const result: ComplexSelector[] = [];
  for (const item of cleaned.split(',')) {
    const complex = parseComplex(item.trim());
    if (!complex) return null;
    result.push(complex);
  }
  return result;
}

function parseComplex(text: string): ComplexSelector | null {
  if (!text) return null;
  // Tokenize into compounds and combinators.
  const tokens: (Compound | ' ' | '>')[] = [];
  let i = 0;
  let pendingSpace = false;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      pendingSpace = tokens.length > 0;
      i++;
      continue;
    }
    if (c === '>') {
      tokens.push('>');
      pendingSpace = false;
      i++;
      continue;
    }
    // compound
    const compound: Compound = { classes: [] };
    let consumed = false;
    while (i < text.length && !/[\s>]/.test(text[i])) {
      const m = /^([.#]?[\w-]+)/.exec(text.slice(i));
      if (!m) return null;
      const tok = m[1];
      consumed = true;
      if (tok.startsWith('.')) compound.classes.push(tok.slice(1));
      else if (tok.startsWith('#')) compound.id = tok.slice(1);
      else compound.tag = tok.toLowerCase();
      i += tok.length;
    }
    if (!consumed) return null;
    if (pendingSpace) tokens.push(' ');
    pendingSpace = false;
    tokens.push(compound);
  }
  const compounds = tokens.filter((t): t is Compound => typeof t !== 'string');
  if (!compounds.length) return null;
  const combinators = tokens.filter((t): t is ' ' | '>' => typeof t === 'string');
  if (combinators.length !== compounds.length - 1) return null;
  const parts: ComplexSelector['parts'] = [];
  for (let k = compounds.length - 1; k > 0; k--)
    parts.push({ combinator: combinators[k - 1], compound: compounds[k - 1] });
  return { parts, subject: compounds[compounds.length - 1] };
}

function matchesCompound(el: SourceElement, c: Compound): boolean {
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classes.includes(cls)) return false;
  return true;
}

export function matchesSelector(
  el: SourceElement,
  elements: SourceElement[],
  complex: ComplexSelector
): boolean {
  if (!matchesCompound(el, complex.subject)) return false;
  let current = el;
  for (const part of complex.parts) {
    let parent = current.parent >= 0 ? elements[current.parent] : undefined;
    if (part.combinator === '>') {
      if (!parent || !matchesCompound(parent, part.compound)) return false;
      current = parent;
    } else {
      while (parent && !matchesCompound(parent, part.compound))
        parent = parent.parent >= 0 ? elements[parent.parent] : undefined;
      if (!parent) return false;
      current = parent;
    }
  }
  return true;
}

// A rule is owned by the selected subtree iff it matches at least one element
// and every matching element lies inside the selected element's source range.
export function ownedBySubtree(
  selectorText: string,
  elements: SourceElement[],
  selected: SourceElement
): boolean | null {
  const list = parseSelectorList(selectorText);
  if (!list) return null;
  let any = false;
  for (const complex of list) {
    for (const el of elements) {
      if (!matchesSelector(el, elements, complex)) continue;
      any = true;
      if (el.file !== selected.file || el.start < selected.start || el.end > selected.end)
        return false;
    }
  }
  return any ? true : false;
}
