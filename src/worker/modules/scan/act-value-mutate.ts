import type { TemplateManifest } from '../../../passkit/types.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { Pass } from '../passes/repo-map.ts';
import { ScanEffectStop, type ValueEffect } from './effects-value.ts';

export const passChanged = () =>
  new ConflictError('The pass changed. Scan again.', 'SCAN_PASS_CHANGED');

/**
 * What must still hold of the pass on each publish attempt. A retry cannot mend a removal, a
 * credential that moved, a quarantine or a void: those answer at once.
 */
export function assertPassStill(current: Pass, read: Pass, action: ResolvedScanAction): void {
  if (current.templateVersion !== read.templateVersion)
    throw new ConflictError('The pass changed. Retry.', 'PASS_CONFLICT');
  if (
    current.removedAt !== null ||
    current.credentialGeneration !== read.credentialGeneration ||
    current.lifecycleGeneration !== read.lifecycleGeneration ||
    current.testDataQuarantined
  )
    throw passChanged();
  if (current.status === 'voided') throw new ScanEffectStop('voided');
  // A sync may have claimed the field since the read.
  if (
    action.input &&
    current.fieldSources[action.input] === 'connection' &&
    !action.allowOnConnected
  )
    throw new ScanEffectStop('managed_elsewhere');
}

/** The stamp that takes a card to its goal. */
export function fillsCard(
  action: ResolvedScanAction,
  stamps: TemplateManifest['stamps'],
  effect: Pick<ValueEffect, 'before' | 'after'>,
): boolean {
  const { before, after } = effect;
  return (
    stamps !== undefined &&
    stamps.input === action.input &&
    action.kind === 'add' &&
    typeof before === 'number' &&
    typeof after === 'number' &&
    before < stamps.goal &&
    after >= stamps.goal
  );
}
