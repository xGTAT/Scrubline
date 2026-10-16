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
