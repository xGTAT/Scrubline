import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Checkpoint } from '../bridge/timeline';
import { Restore } from '../review/restore';
import { scan, changedPaths } from '../capture/scanner';
import { validateCandidate } from './validate';
import { DualVerificationEngine } from '../verification/engine';
import type { VerificationReport, VerificationOptions } from '../verification/types';
import type { PreviewConfig } from '../preview/runner';

export interface SelectiveApplyOptions {
  verify?: {
    previewConfig?: PreviewConfig;
    historical?: Checkpoint;
    current?: Checkpoint;
    targetSelector?: string;
    documentPath?: string;
    options?: VerificationOptions;
  };
}

export async function applySelective(
  restore: Restore,
  target: Checkpoint,
  token: string,
  unsaved: boolean,
  command: string,
  dirty: () => boolean = () => unsaved,
  options?: SelectiveApplyOptions
) {
  // Automated Dual-Verification Pass before applying changes
  let verificationReport: VerificationReport | undefined;
  if (options?.verify) {
    const { verify } = options;
    if (
      verify.previewConfig?.command &&
      verify.previewConfig?.browserPath &&
      verify.historical &&
      verify.current
    ) {
      verificationReport = await DualVerificationEngine.verifyStagedCheckpoint({
        store: restore.store,
        previewConfig: verify.previewConfig,
        historical: verify.historical,
        current: verify.current,
        candidate: target,
        targetSelector: verify.targetSelector || '',
        documentPath: verify.documentPath || 'index.html',
        options: verify.options
      });
    } else if (verify.current) {
      verificationReport = await DualVerificationEngine.verifyStaticDocuments({
        store: restore.store,
        current: verify.current,
        candidate: target,
        targetSelector: verify.targetSelector || '',
        documentPath: verify.documentPath || 'index.html',
        options: verify.options
      });
    }

    if (verificationReport && verificationReport.status === 'failed') {
      const err = Object.assign(
        new Error(
          verificationReport.failureReason || 'Verification failed: collateral mutations detected.'
        ),
        { verificationReport }
      );
      throw err;
    }
  }

  const directory = path.join(restore.store.root, 'validate', randomUUID());
  await restore.store.materialize(target, directory);
  try {
    await validateCandidate(command, directory);
    const checked = await scan(directory, restore.store.root, restore.limits);
    if (changedPaths(target.files, checked.files).length)
      throw new Error('Build/test changed candidate sources. Nothing applied.');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }

  const accepted = await restore.apply(token, target, dirty());
  try {
    await validateCandidate(command, restore.workspace);
    const actual = await scan(restore.workspace, restore.store.root, restore.limits);
    if (changedPaths(accepted.files, actual.files).length)
      throw new Error('Post-apply modified tracked sources.');
  } catch {
    try {
      await restore.undo(accepted, dirty());
    } catch {
      throw new Error('Post-apply failed; concurrent bytes preserved. Review safety checkpoint.');
    }
    throw new Error('Post-apply failed. Applied files rolled back.');
  }

  if (verificationReport) {
    Object.assign(accepted, { verificationReport });
  }
  return accepted;
}
