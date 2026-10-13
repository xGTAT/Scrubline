import * as fs from 'node:fs/promises';
import type { RenderReceipt } from '../evidence/types';
import { hashBytes } from '../store/store';
export async function readReceipt(
  image: string,
  checkpoint?: string,
  specification?: string
): Promise<RenderReceipt | undefined> {
  try {
    const receipt: RenderReceipt = JSON.parse(await fs.readFile(`${image}.receipt.json`, 'utf8'));
    if (
      receipt.version !== 1 ||
      (checkpoint && receipt.checkpoint !== checkpoint) ||
      (specification && receipt.specification !== specification) ||
      receipt.imageHash !== hashBytes(await fs.readFile(image)) ||
      receipt.geometryHash !== hashBytes(await fs.readFile(`${image}.json`)) ||
      !receipt.viewport ||
      !Number.isInteger(receipt.viewport.width) ||
      !Number.isInteger(receipt.viewport.height) ||
      receipt.viewport.width < 240 ||
      receipt.viewport.width > 3840 ||
      receipt.viewport.height < 240 ||
      receipt.viewport.height > 3840 ||
      typeof receipt.browserVersion !== 'string' ||
      !['not-rechecked', 'repeatable-in-two-probes', 'unstable'].includes(receipt.repeatability)
    )
      return;
    return receipt;
  } catch {
    return;
  }
}
