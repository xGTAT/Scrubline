// Survives loading a newer extension bundle in the same extension host.
const key = Symbol.for('scrubline.activation.owner.v1');
type Owner = { close: () => Promise<void> };
const registry = globalThis as typeof globalThis & { [key]?: Owner };
export async function replaceActivation(close: () => Promise<void>) {
  const previous = registry[key];
  if (previous) await previous.close();
  const owner = { close };
  registry[key] = owner;
  return () => {
    if (registry[key] === owner) delete registry[key];
  };
}
