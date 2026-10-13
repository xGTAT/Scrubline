export interface LayoutGuard {
  kind: 'horizontal-overflow' | 'containment';
  selector?: string;
  container?: string;
  tolerance: number;
}
export interface LayoutResult {
  version: 1;
  checkpoint: string;
  specification: string;
  guard: LayoutGuard;
  outcome: 'pass' | 'fail' | 'unknown';
  measured?: number;
  message: string;
}
export interface LayoutCell {
  checkpoint: string;
  width: number;
  result: LayoutResult;
  image?: string;
}
export interface LayoutMatrix {
  running: boolean;
  done: number;
  total: number;
  cancelled?: boolean;
  cells: LayoutCell[];
  widths: number[];
  checkpoints: string[];
  message?: string;
}
export function validateGuard(guard: LayoutGuard) {
  if (
    !guard ||
    !['horizontal-overflow', 'containment'].includes(guard.kind) ||
    !Number.isFinite(guard.tolerance) ||
    guard.tolerance < 0 ||
    guard.tolerance > 100
  )
    throw new Error('Choose a valid geometry assertion and tolerance from 0 to 100.');
  if (
    guard.kind === 'containment' &&
    [guard.selector, guard.container].some(
      (s) => typeof s !== 'string' || !s.trim() || s.length > 1000
    )
  )
    throw new Error('Containment needs unique element and container selectors.');
}
export function validateSweep(widths: number[], checkpoints: string[]) {
  if (
    !Array.isArray(widths) ||
    !widths.length ||
    widths.length > 8 ||
    new Set(widths).size !== widths.length ||
    widths.some((w) => !Number.isInteger(w) || w < 240 || w > 3840)
  )
    throw new Error('Choose 1 to 8 distinct widths from 240 to 3840.');
  if (
    !checkpoints.length ||
    checkpoints.length > 5 ||
    new Set(checkpoints).size !== checkpoints.length ||
    widths.length * checkpoints.length > 24
  )
    throw new Error('Choose up to 5 checkpoints and at most 24 probes.');
}
