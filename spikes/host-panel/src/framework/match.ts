// Match a picked rendered element to a source element, and map a source
// element between two checkpoint versions of the same file. Unique confident
// match or refusal - never a guess.
import type { PickInfo, SourceElement, SourceIndex } from './types';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 300);

// Rendered picks carry the element's full textContent, so match against the
// aggregated static text of the whole source subtree, not direct text only.
export function subtreeText(index: SourceIndex): Map<SourceElement, string> {
  const memo = new Map<SourceElement, string>();
  const compute = (e: SourceElement): string => {
    const cached = memo.get(e);
    if (cached !== undefined) return cached;
    memo.set(e, ''); // cycle guard
    const kids = index.elements.filter((k) => k.parent === index.elements.indexOf(e));
    const text = norm([e.text, ...kids.map(compute)].filter(Boolean).join(' '));
    memo.set(e, text);
    return text;
  };
  for (const e of index.elements) compute(e);
  return memo;
}

export function matchPicked(indexes: SourceIndex[], pick: PickInfo): SourceElement {
  const all = indexes.flatMap((i) => i.elements).filter((e) => !e.component);
  const tag = pick.tag?.toLowerCase();
  const candidates = tag ? all.filter((e) => e.tag === tag) : all;
  if (pick.id) {
    const byId = all.filter((e) => e.id === pick.id);
    if (byId.length === 1) return byId[0];
    if (byId.length > 1)
      throw new Error(
        `Cannot map the selected element into source: id "${pick.id}" appears ${byId.length} times.`
      );
    throw new Error(`No source element with id "${pick.id}". Review the whole file instead.`);
  }
  if (pick.testId) {
    const byTest = all.filter((e) => e.testId === pick.testId);
    if (byTest.length === 1) return byTest[0];
    if (byTest.length > 1)
      throw new Error(
        `Cannot map the selected element into source: data-testid "${pick.testId}" appears ${byTest.length} times.`
      );
    throw new Error(
      `No source element with data-testid "${pick.testId}". Review the whole file instead.`
    );
  }
  const text = pick.text ? norm(pick.text) : '';
  const subtree = new Map<SourceElement, string>();
  for (const idx of indexes) for (const [e, t] of subtreeText(idx)) subtree.set(e, t);
  const scored = candidates.map((e) => {
    let score = 0;
    const aggregated = subtree.get(e) ?? '';
    if (text && aggregated) {
      if (aggregated === text) score += 4;
      else if (text.length >= 8 && aggregated.includes(text)) score += 3;
      else if (
        text.length >= 12 &&
        (aggregated.startsWith(text.slice(0, 30)) || text.startsWith(aggregated.slice(0, 30)))
      )
        score += 2;
    }
    if (pick.name && e.name && norm(e.name) === norm(pick.name)) score += 3;
    if (pick.href && e.href && e.href === pick.href) score += 1;
    if (text && !aggregated) score -= 1;
    return { e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1];
  if (!top || top.score < 3 || (second && top.score - second.score < 2))
    throw new Error(
      `Cannot map the selected <${tag ?? 'element'}> into current source: ${scored.filter((s) => s.score >= top?.score - 1).length} similar candidates. Add a unique id or data-testid, or review the whole file instead.`
    );
  return top.e;
}

// Map a source element from the old version of a file into the current version.
export function mapIdentity(
  oldEl: SourceElement,
  oldFile: SourceIndex,
  nowFile: SourceIndex
): SourceElement {
  if (oldEl.id) {
    const now = nowFile.elements.filter((e) => e.id === oldEl.id);
    const old = oldFile.elements.filter((e) => e.id === oldEl.id);
    if (now.length === 1 && old.length === 1) return now[0];
    throw new Error(
      `Cannot map the selected <${oldEl.tag}> into current source: id "${oldEl.id}" is not unique across versions. Review the whole file instead.`
    );
  }
  const sig = (e: SourceElement, withText: boolean) =>
    JSON.stringify([e.tag, e.component, withText ? norm(e.text) : '', e.ancestors]);
  for (const withText of [true, false]) {
    const key = sig(oldEl, withText);
    const now = nowFile.elements.filter((e) => sig(e, withText) === key);
    const old = oldFile.elements.filter((e) => sig(e, withText) === key);
    if (now.length === 1 && old.length === 1) return now[0];
  }
  throw new Error(
    `Cannot map the selected <${oldEl.tag}> into current source: the surrounding structure changed. Review the whole file instead.`
  );
}
