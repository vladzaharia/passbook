import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { insertEventStmt } from '../events/repo.ts';
import { historyPlan } from './card.ts';
import type { CountsPlan } from './counts.ts';
import type { ScanActor } from './guard.ts';
import { ledgerRow, recordResult } from './ledger.ts';
import { stopOutcome } from './outcome.ts';
import { finalizeStmt, releaseClaimStmt } from './repo-scans.ts';
import type { Stop } from './resolve.ts';

export interface StopContext {
  ctx: ServiceContext;
  actor: ScanActor;
  scanId: string;
  method: string;
  counts: CountsPlan;
  action: ResolvedScanAction | null;
  overrideOf: string | null;
}

/**
 * Closes the claimed row with a refusal or heads-up that came before any gate: the row, the
 * ledger event of a known pass and the counts go in one batch.
 */
export async function finishStop(s: StopContext, stop: Stop): Promise<ScanOutcome> {
  const { ctx, actor, counts } = s;
  const db = ctx.env.DB;
  const pass = stop.pass;
  const ledger = pass
    ? insertEventStmt(
        db,
        ledgerRow(ctx, actor, {
          pass,
          scanId: s.scanId,
          action: s.action,
          outcome: stop.kind,
          reason: stop.reason,
          method: s.method,
          override: s.overrideOf !== null,
          approvedBy: null,
        }),
      )
    : null;
  const history = stop.found ? historyPlan(ctx, actor, stop.found) : null;
  const results = await db.batch([
    finalizeStmt(db, {
      id: s.scanId,
      outcome: stop.kind,
      reason: stop.reason,
      passId: pass?.id ?? null,
      templateId: pass?.templateId ?? null,
      actionId: s.action?.id ?? null,
      actionKind: s.action?.kind ?? null,
      passVersion: null,
      overrideOf: s.overrideOf,
      approvedBy: null,
    }),
    ...(ledger ? [ledger] : []),
    ...counts.stmts,
    ...(history?.stmts ?? []),
  ]);
  const at = 1 + (ledger ? 1 : 0);
  const read = await counts.read(results.slice(at, at + counts.stmts.length));
  recordResult(ctx, actor, pass?.templateId ?? null, stop.reason, pass?.mode);
  return stopOutcome(ctx, actor, stop, read, {
    action: s.action,
    scanId: s.scanId,
    history: history?.read(results.slice(at + counts.stmts.length)),
  });
}

/** A heads-up that leaves no row and no idempotency entry (`needs_approval`, SA 2.6 step 14). */
export async function answerWithoutRow(s: StopContext, stop: Stop): Promise<ScanOutcome> {
  const { ctx, actor, counts } = s;
  const [, results] = await Promise.all([
    releaseClaimStmt(ctx.env.DB, s.scanId).run(),
    ctx.env.DB.batch(counts.stmts),
  ]);
  return stopOutcome(ctx, actor, stop, await counts.read(results), { action: s.action });
}
