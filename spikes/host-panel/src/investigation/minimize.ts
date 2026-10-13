export type Outcome = 'pass' | 'fail' | 'unknown';
export async function minimize<T>(
  units: readonly T[],
  probe: (subset: T[]) => Promise<Outcome>,
  budget: number,
  cancelled: () => boolean = () => false
) {
  let current = [...units],
    probes = 0,
    unresolved = false,
    verified = false;
  if (!Number.isInteger(budget) || budget < 1 || budget > 32)
    throw new Error('Invalid investigation budget.');
  // Repeated elimination establishes single-removal minimality, not global uniqueness.
  while (probes < budget && !cancelled()) {
    let removed = false;
    unresolved = false;
    for (let i = 0; i < current.length; i++) {
      if (probes >= budget || cancelled()) break;
      const subset = current.filter((_, j) => j !== i);
      const outcome = await probe(subset);
      probes++;
      if (outcome === 'fail') {
        current = subset;
        removed = true;
        break;
      }
      if (outcome === 'unknown') unresolved = true;
      if (i === current.length - 1 && !unresolved) verified = true;
    }
    if (!removed) break;
  }
  return {
    units: current,
    probes,
    minimal: verified && !cancelled(),
    cancelled: cancelled(),
    unresolved
  };
}
