import { test, expect } from 'vitest';
import { validateStructuralInvariants } from '../../src/verification/structural';
import type {
  StructuralFingerprint,
  StructuralNodeFingerprint
} from '../../src/verification/types';

const node = (
  selector: string,
  tag: string,
  extra?: Partial<StructuralNodeFingerprint>
): StructuralNodeFingerprint => ({
  selector,
  tag,
  isTarget: false,
  isSibling: false,
  box: { x: 0, y: 0, width: 100, height: 20 },
  styles: { display: 'block', visibility: 'visible', opacity: 1 },
  present: true,
  ...extra
});

const baseline: StructuralFingerprint = {
  timestamp: 't0',
  targetSelector: '#cta',
  nodes: [
    node('#cta', 'button', { isTarget: true }),
    node('main .promo .blurb', 'p') // ordinary element, not a landmark
  ]
};

const candidateMissingBlurb: StructuralFingerprint = {
  timestamp: 't1',
  targetSelector: '#cta',
  nodes: [node('#cta', 'button', { isTarget: true })]
};

test('default validation ignores vanished non-landmark elements', () => {
  const violations = validateStructuralInvariants(baseline, candidateMissingBlurb, {});
  expect(violations.filter((v) => v.selector === 'main .promo .blurb')).toHaveLength(0);
});

test('protectAllElements flags a vanished non-landmark element', () => {
  const violations = validateStructuralInvariants(baseline, candidateMissingBlurb, {
    protectAllElements: true
  });
  const hit = violations.find((v) => v.selector === 'main .promo .blurb');
  expect(hit).toBeDefined();
  expect(hit!.kind).toBe('missing');
});

const styled = (over: Record<string, string>) => ({
  display: 'block',
  visibility: 'visible',
  opacity: 1,
  ...over
});

test('computed-style drift flags a restyled protected element', () => {
  const base: StructuralFingerprint = {
    timestamp: 't0',
    nodes: [
      node('#cta', 'button', { isTarget: true }),
      node('#card', 'div', {
        id: 'card',
        styles: styled({ color: 'rgb(0, 0, 0)', fontSize: '16px' })
      })
    ]
  };
  const cand: StructuralFingerprint = {
    timestamp: 't1',
    nodes: [
      node('#cta', 'button', { isTarget: true }),
      node('#card', 'div', {
        id: 'card',
        styles: styled({ color: 'rgb(255, 0, 0)', fontSize: '16px' })
      })
    ]
  };
  const violations = validateStructuralInvariants(base, cand, {});
  const hit = violations.find((v) => v.selector === '#card');
  expect(hit).toBeDefined();
  expect(hit!.kind).toBe('restyled');
  expect(hit!.message).toContain('color');
});

test('computed-style comparison tolerates sub-pixel font-size noise and whitespace in colors', () => {
  const base: StructuralFingerprint = {
    timestamp: 't0',
    nodes: [node('#card', 'div', { styles: styled({ color: 'rgb(0, 0, 0)', fontSize: '16px' }) })]
  };
  const cand: StructuralFingerprint = {
    timestamp: 't1',
    nodes: [node('#card', 'div', { styles: styled({ color: 'rgb(0,0,0)', fontSize: '16.4px' }) })]
  };
  expect(validateStructuralInvariants(base, cand, {})).toHaveLength(0);
});

test('computed-style comparison skips properties missing from either fingerprint (offline capture)', () => {
  const base: StructuralFingerprint = {
    timestamp: 't0',
    nodes: [node('#card', 'div', { styles: styled({}) })] // no widened props: offline capture
  };
  const cand: StructuralFingerprint = {
    timestamp: 't1',
    nodes: [node('#card', 'div', { styles: styled({ color: 'rgb(255, 0, 0)' }) })]
  };
  expect(validateStructuralInvariants(base, cand, {})).toHaveLength(0);
});
