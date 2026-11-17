import type { AfterRead } from '../../platform/authority-after.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { planCommitCounts } from './counts.ts';
import { blankOutcome } from './outcome.ts';
import { byIdStmt, candidatesOf } from './repo-lookup.ts';
import { afterReads, capturingDb } from './scan-capture.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';

export interface UndoAnswerPlan {
  /** Run these in the undo's commit (`commitWith`): they see its writes and cost no round trip. */
  reads: AfterRead[];
  /** The committed undo's outcome from the results of `reads`. */
  finish(after: readonly D1Result[], scanId: string): Promise<ScanEvaluation>;
}

/**
 * The answer to a committed undo: current counts and the pass the live view re-renders. Both are
 * read in the commit's own transaction, after its release, so the answer never costs a trip of its own.
 */
export function planUndoAnswer(
  ctx: ServiceContext,
  actor: ScanActor,
  passId: string | null,
): UndoAnswerPlan {
  const db = capturingDb(ctx.env.DB);
  const counts = planCommitCounts({ ...ctx, env: { ...ctx.env, DB: db } }, actor);
  const candidate = passId ? byIdStmt(db, actor.orgId, passId) : null;
  return {
    reads: afterReads([...counts.stmts, ...(candidate ? [candidate] : [])]),
    async finish(after, scanId) {
      const selected = candidate ? (candidatesOf(after[counts.stmts.length])[0] ?? null) : null;
      return {
        outcome: {
          ...blankOutcome(
            'ok',
            await counts.read(after.slice(0, counts.stmts.length) as D1Result[]),
          ),
          scanId,
          replay: false,
          action: { id: 'undo', label: 'Undone', kind: 'check_in' },
          at: ctx.clock.now(),
        },
        evaluatedSnapshot: selected,
        credentialContext: selected && {
          credentialTombstoneRefs: selected.credentialTombstoneRefs,
          otherModeCredentialTombstoneRefs: selected.otherModeCredentialTombstoneRefs,
          credentialKeysetCommitment: selected.credentialKeysetCommitment,
        },
      };
    },
  };
}
