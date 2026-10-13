import type { Checkpoint } from '../bridge/timeline';
import type { LayoutCell, LayoutMatrix, LayoutResult } from './types';
import { validateSweep } from './types';
export async function sweep(
  checkpoints: Checkpoint[],
  widths: number[],
  probe: (
    checkpoint: Checkpoint,
    width: number
  ) => Promise<{ result: LayoutResult; image?: string }>,
  cancelled: () => boolean,
  notify: (matrix: LayoutMatrix) => void
) {
  validateSweep(
    widths,
    checkpoints.map((c) => c.id)
  );
  const cells: LayoutCell[] = [];
  const state: LayoutMatrix = {
    running: true,
    done: 0,
    total: checkpoints.length * widths.length,
    cells,
    widths,
    checkpoints: checkpoints.map((c) => c.id)
  };
  notify({ ...state, cells: [...cells] });
  for (const c of checkpoints) {
    for (const width of widths) {
      if (cancelled()) break;
      const value = await probe(c, width);
      if (cancelled()) break;
      cells.push({ checkpoint: c.id, width, ...value });
      state.done++;
      notify({ ...state, cells: [...cells] });
    }
    if (cancelled()) break;
  }
  state.running = false;
  state.cancelled = cancelled();
  notify({
    ...state,
    cells: [...cells],
    message: 'Only sampled widths checked. Unsampled intervals are unknown.'
  });
  return state;
}
