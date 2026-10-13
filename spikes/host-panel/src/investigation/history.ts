import type { Checkpoint } from '../bridge/timeline';
export function ancestry(checkpoints: readonly Checkpoint[], good: string, bad: string) {
  const result: Checkpoint[] = [];
  let cp = checkpoints.find((c) => c.id === bad && !c.branch);
  while (cp) {
    result.unshift(cp);
    if (cp.id === good) break;
    cp = checkpoints.find((c) => c.id === cp!.parentId && !c.branch);
  }
  if (result[0]?.id !== good || result.length < 2 || result.length > 5)
    throw new Error('Choose ordered main checkpoints spanning 2 to 5 saved states.');
  return result;
}
