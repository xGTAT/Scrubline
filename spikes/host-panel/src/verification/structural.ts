import type { Page } from 'playwright-core';
import { parse } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';
import { selectAll } from 'css-select';
import type {
  BoundingBox,
  ComputedStyles,
  StructuralFingerprint,
  StructuralNodeFingerprint,
  InvariantViolation,
  VerificationOptions
} from './types';

export const KEY_STRUCTURAL_SELECTORS = [
  'header',
  'nav',
  'main',
  'footer',
  'aside',
  '[role="banner"]',
  '[role="navigation"]',
  '[role="main"]',
  '[role="contentinfo"]',
  '[role="complementary"]'
];

/**
 * Capture structural fingerprint from a live Playwright page.
 */
export async function captureStructuralFingerprint(
  page: Page,
  targetSelector?: string,
  extraSelectors: string[] = []
): Promise<StructuralFingerprint> {
  const combinedSelectors = Array.from(new Set([...KEY_STRUCTURAL_SELECTORS, ...extraSelectors]));

  return page.evaluate(
    ({ selectors, targetSel }) => {
      const targetEl = targetSel ? document.querySelector(targetSel) : null;
      const targetSiblings = targetEl?.parentElement
        ? Array.from(targetEl.parentElement.children).filter((el) => el !== targetEl)
        : [];

      const queryMatches = new Set<Element>();
      for (const sel of selectors) {
        try {
          document.querySelectorAll(sel).forEach((el) => queryMatches.add(el));
        } catch {
          // Ignore invalid selector
        }
      }

      // Also gather elements with IDs
      document.querySelectorAll('[id]').forEach((el) => {
        if (
          !['html', 'head', 'body', 'script', 'style', 'link'].includes(el.tagName.toLowerCase())
        ) {
          queryMatches.add(el);
        }
      });

      // Add target siblings
      targetSiblings.forEach((el) => queryMatches.add(el));

      // Add target itself if present
      if (targetEl) {
        queryMatches.add(targetEl);
      }

      const getSelector = (el: Element): string => {
        if (el.id) return `#${el.id}`;
        const tag = el.tagName.toLowerCase();
        if (['header', 'nav', 'main', 'footer', 'aside'].includes(tag)) {
          const count = document.querySelectorAll(tag).length;
          if (count === 1) return tag;
        }
        const role = el.getAttribute('role');
        if (role) {
          const roleSel = `[role="${role}"]`;
          if (document.querySelectorAll(roleSel).length === 1) return roleSel;
        }
        // Build path relative to parent
        const parent = el.parentElement;
        if (!parent || parent === document.body) {
          const siblings = parent ? Array.from(parent.children) : [];
          const sameTag = siblings.filter((s) => s.tagName === el.tagName);
          return sameTag.length === 1 ? tag : `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`;
        }
        const siblings = Array.from(parent.children).filter((s) => s.tagName === el.tagName);
        const index = siblings.indexOf(el) + 1;
        return `${parent.tagName.toLowerCase()} > ${tag}:nth-of-type(${index})`;
      };

      const nodes: StructuralNodeFingerprint[] = [];
      queryMatches.forEach((el) => {
        const tag = el.tagName.toLowerCase();
        if (['script', 'style', 'link', 'meta', 'noscript'].includes(tag)) return;

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const isTarget = targetEl ? el === targetEl : false;
        const isSibling = targetSiblings.includes(el);

        const box: BoundingBox = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };

        const computed: ComputedStyles = {
          display: style.display,
          visibility: style.visibility,
          opacity: Number(style.opacity || '1')
        };

        // Hash content
        const text = (el.textContent || '').trim().slice(0, 100);
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
          hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
        }

        nodes.push({
          selector: getSelector(el),
          tag,
          id: el.id || undefined,
          className: el.className ? String(el.className) : undefined,
          isTarget,
          isSibling,
          box,
          styles: computed,
          present: true,
          textHash: String(hash)
        });
      });

      return {
        timestamp: new Date().toISOString(),
        targetSelector: targetSel,
        nodes
      };
    },
    { selectors: combinedSelectors, targetSel: targetSelector }
  );
}

/**
 * Capture structural fingerprint offline from raw HTML using parse5.
 */
export function captureStructuralFingerprintFromHtml(
  html: string,
  targetSelector?: string
): StructuralFingerprint {
  const tree = parse(html, { treeAdapter: adapter, sourceCodeLocationInfo: true });
  const nodes: StructuralNodeFingerprint[] = [];

  const getAttr = (node: object, name: string): string | undefined => {
    return 'attribs' in node && node.attribs && typeof node.attribs === 'object'
      ? (node.attribs as Record<string, string>)[name]
      : undefined;
  };

  const allElements = selectAll('*', tree);

  for (const el of allElements) {
    const rawTag = 'tagName' in el && typeof el.tagName === 'string' ? el.tagName : '';
    const tag = rawTag.toLowerCase();
    if (
      !tag ||
      ['html', 'head', 'body', 'script', 'style', 'link', 'meta', 'title'].includes(tag)
    ) {
      continue;
    }

    const id = getAttr(el, 'id');
    const className = getAttr(el, 'class');
    const role = getAttr(el, 'role');
    const styleAttr = getAttr(el, 'style') || '';

    const isStructural =
      ['header', 'nav', 'main', 'footer', 'aside'].includes(tag) ||
      ['banner', 'navigation', 'main', 'contentinfo'].includes(role || '') ||
      !!id;

    if (!isStructural && tag !== 'section' && tag !== 'div') {
      continue;
    }

    const isDisplayNone = /display\s*:\s*none/i.test(styleAttr);
    const isVisibilityHidden = /visibility\s*:\s*hidden/i.test(styleAttr);
    const isOpacityZero = /opacity\s*:\s*0(?![.\d])/i.test(styleAttr);

    const selector = id ? `#${id}` : role ? `[role="${role}"]` : tag;
    const isTarget = targetSelector
      ? selector === targetSelector || (id && `#${id}` === targetSelector)
      : false;

    nodes.push({
      selector,
      tag,
      id,
      className,
      isTarget: Boolean(isTarget),
      isSibling: false,
      box: { x: 0, y: 0, width: isDisplayNone ? 0 : 100, height: isDisplayNone ? 0 : 50 },
      styles: {
        display: isDisplayNone ? 'none' : 'block',
        visibility: isVisibilityHidden ? 'hidden' : 'visible',
        opacity: isOpacityZero ? 0 : 1
      },
      present: true
    });
  }

  return {
    timestamp: new Date().toISOString(),
    targetSelector,
    nodes
  };
}

/**
 * Validate candidate fingerprint against baseline fingerprint for structural invariant fidelity.
 */
export function validateStructuralInvariants(
  baseline: StructuralFingerprint,
  candidate: StructuralFingerprint,
  options: VerificationOptions = {}
): InvariantViolation[] {
  const tolerancePx = options.tolerancePx ?? 15;
  const violations: InvariantViolation[] = [];

  // Map candidate nodes by selector and id
  const candidateBySelector = new Map<string, StructuralNodeFingerprint>();
  const candidateById = new Map<string, StructuralNodeFingerprint>();
  const candidateByTag = new Map<string, StructuralNodeFingerprint[]>();

  for (const node of candidate.nodes) {
    candidateBySelector.set(node.selector, node);
    if (node.id) candidateById.set(node.id, node);
    const list = candidateByTag.get(node.tag) ?? [];
    list.push(node);
    candidateByTag.set(node.tag, list);
  }

  // Check invariants for every non-target node in baseline
  for (const baseNode of baseline.nodes) {
    if (baseNode.isTarget) continue;

    // Only protect key structural elements, siblings, or explicit landmarks
    const isKeyStructural =
      ['header', 'nav', 'main', 'footer', 'aside'].includes(baseNode.tag) ||
      baseNode.isSibling ||
      (baseNode.id &&
        ['header', 'nav', 'sidebar', 'footer', 'navbar', 'menu'].some((k) =>
          baseNode.id!.toLowerCase().includes(k)
        )) ||
      baseNode.selector.includes('role=');

    if (!isKeyStructural && !baseNode.id) continue;

    // Find candidate counterpart
    let candNode = candidateBySelector.get(baseNode.selector);
    if (!candNode && baseNode.id) {
      candNode = candidateById.get(baseNode.id);
    }
    if (!candNode && ['header', 'nav', 'main', 'footer'].includes(baseNode.tag)) {
      const candidates = candidateByTag.get(baseNode.tag);
      if (candidates && candidates.length === 1) {
        candNode = candidates[0];
      }
    }

    // 1. Missing node violation
    if (!candNode || !candNode.present) {
      violations.push({
        kind: 'missing',
        selector: baseNode.selector,
        tag: baseNode.tag,
        message: `Invariant Violation: <${baseNode.tag}> removed`,
        expected: { box: baseNode.box, styles: baseNode.styles },
        actual: { present: false }
      });
      continue;
    }

    // 2. Hidden node violation
    if (
      candNode.styles.display === 'none' ||
      candNode.styles.visibility === 'hidden' ||
      candNode.styles.opacity === 0
    ) {
      violations.push({
        kind: 'hidden',
        selector: baseNode.selector,
        tag: baseNode.tag,
        message: `Invariant Violation: <${baseNode.tag}> removed or hidden`,
        expected: { box: baseNode.box, styles: baseNode.styles },
        actual: { present: true, box: candNode.box, styles: candNode.styles }
      });
      continue;
    }

    // 3. Collapsed bounding box violation (zero width/height when baseline was visible)
    if (
      baseNode.box.width > 0 &&
      baseNode.box.height > 0 &&
      (candNode.box.width <= 0 || candNode.box.height <= 0)
    ) {
      violations.push({
        kind: 'collapsed',
        selector: baseNode.selector,
        tag: baseNode.tag,
        message: `Invariant Violation: <${baseNode.tag}> collapsed to 0 width/height`,
        expected: { box: baseNode.box, styles: baseNode.styles },
        actual: { present: true, box: candNode.box, styles: candNode.styles }
      });
      continue;
    }

    // 4. Excessive bounding box shift or resize
    if (baseNode.box.width > 0 && baseNode.box.height > 0) {
      const dx = Math.abs(candNode.box.x - baseNode.box.x);
      const dy = Math.abs(candNode.box.y - baseNode.box.y);
      const dw = Math.abs(candNode.box.width - baseNode.box.width);
      const dh = Math.abs(candNode.box.height - baseNode.box.height);

      if (
        dx > tolerancePx * 2 ||
        dy > tolerancePx * 2 ||
        dw > tolerancePx * 2 ||
        dh > tolerancePx * 2
      ) {
        const shiftDist = Math.max(dx, dy, dw, dh);
        violations.push({
          kind: 'shifted',
          selector: baseNode.selector,
          tag: baseNode.tag,
          message: `Invariant Violation: <${baseNode.tag}> bounding box shifted unexpectedly by ${shiftDist.toFixed(0)}px`,
          expected: { box: baseNode.box, styles: baseNode.styles },
          actual: { present: true, box: candNode.box, styles: candNode.styles }
        });
      }
    }
  }

  return violations;
}
