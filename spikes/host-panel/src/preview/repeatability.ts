import type { RenderReceipt } from '../evidence/types';
export function repeatability(probes: readonly RenderReceipt[]): RenderReceipt['repeatability'] {
  if (
    probes.length !== 2 ||
    probes.some(
      (p) => p.specification !== probes[0].specification || p.checkpoint !== probes[0].checkpoint
    )
  )
    throw new Error('Two matching-specification probes required.');
  return probes[0].imageHash === probes[1].imageHash &&
    probes[0].geometryHash === probes[1].geometryHash
    ? 'repeatable-in-two-probes'
    : 'unstable';
}
