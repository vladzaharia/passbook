import type { z } from 'zod';
import type { ScanUndoRequestSchema } from '../../../shared/contracts/scan.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotActionCandidate } from './act-snapshot.ts';
import type { ScanActor } from './actor.ts';
import { planCounts } from './counts.ts';
import { blankOutcome } from './outcome.ts';
import { candidateById } from './repo-lookup.ts';
import type { ScanRow } from './repo-scans.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';

export type UndoRequest = z.infer<typeof ScanUndoRequestSchema>;

/** The outcome of a committed undo: current counts and the pass the live view re-renders. */
export async function answer(
  ctx: ServiceContext,
  actor: ScanActor,
  passId: string | null,
  scanId: string,
  replay: boolean,
): Promise<ScanEvaluation> {
  const db = ctx.env.DB;
  const counts = planCounts(ctx, actor);
  const [selected, results] = await Promise.all([
    passId ? candidateById(db, actor.orgId, passId) : null,
    db.batch(counts.stmts),
  ]);
  const candidate = selected ? snapshotActionCandidate(selected) : null;
  return {
    outcome: {
      ...blankOutcome('ok', await counts.read(results)),
      scanId,
      replay,
      action: { id: 'undo', label: 'Undone', kind: 'check_in' },
      at: ctx.clock.now(),
    },
    evaluatedSnapshot: candidate,
    credentialContext: candidate && {
      credentialTombstoneRefs: candidate.credentialTombstoneRefs,
      otherModeCredentialTombstoneRefs: candidate.otherModeCredentialTombstoneRefs,
      credentialKeysetCommitment: candidate.credentialKeysetCommitment,
    },
  };
}

/** A retry returns the committed undo. The idempotency identity is the only thing it checks. */
export async function replayUndo(
  ctx: ServiceContext,
  actor: ScanActor,
  scanId: string,
  existing: ScanRow,
): Promise<ScanEvaluation> {
  if (
    existing.requestHash !== `undo:${scanId}` ||
    existing.actionKind !== 'undo' ||
    existing.orgId !== actor.orgId ||
    existing.mode !== actor.mode
  )
    throw new ValidationError('That key was used for another scan.', [], 'IDEMPOTENCY_KEY_REUSED');
  return answer(ctx, actor, existing.passId, existing.id, true);
}
