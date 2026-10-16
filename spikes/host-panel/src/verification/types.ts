export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputedStyles {
  display: string;
  visibility: string;
  opacity: number;
  // Widened computed-style comparison (live captures only; offline markup
  // fingerprints leave these undefined and the comparison skips them).
  position?: string;
  zIndex?: string;
  fontSize?: string;
  fontWeight?: string;
  color?: string;
  backgroundColor?: string;
}

export interface StructuralNodeFingerprint {
  selector: string;
  tag: string;
  id?: string;
  className?: string;
  isTarget: boolean;
  isSibling: boolean;
  box: BoundingBox;
  styles: ComputedStyles;
  present: boolean;
  textHash?: string;
}

export interface StructuralFingerprint {
  timestamp: string;
  targetSelector?: string;
  nodes: StructuralNodeFingerprint[];
}

export type InvariantViolationKind = 'missing' | 'hidden' | 'collapsed' | 'shifted' | 'restyled';

export interface InvariantViolation {
  kind: InvariantViolationKind;
  selector: string;
  tag: string;
  message: string;
  expected: {
    box: BoundingBox;
    styles: ComputedStyles;
  };
  actual?: {
    box?: BoundingBox;
    styles?: ComputedStyles;
    present: boolean;
  };
}

export interface VisualCropDiff {
  region: 'target' | 'surrounding';
  selector: string;
  tag?: string;
  diffRatio: number;
  passed: boolean;
  threshold: number;
  boundingBox: BoundingBox;
  diffHighlight?: string; // data URL or base64 PNG
  message?: string;
}

export interface VerificationReport {
  status: 'passed' | 'failed';
  targetSelector: string;
  structuralViolations: InvariantViolation[];
  visualDiffs: VisualCropDiff[];
  failureReason?: string;
  summary: string;
  diffHighlights?: string[];
  verifiedAt: string;
}

export interface VerificationOptions {
  tolerancePx?: number;
  visualDiffThreshold?: number;
  targetDiffThreshold?: number;
  invariantSelectors?: string[];
  captureVisualDiffs?: boolean;
  /**
   * Element-scoped reverts: every non-target element in the baseline must
   * survive the candidate, not just landmark regions. Catches reverts that
   * silently drop ordinary elements.
   */
  protectAllElements?: boolean;
}
