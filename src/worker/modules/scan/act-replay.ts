import type { ScanOutcome, ScanReason } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { completedAdmission, planAdmission } from './admission.ts';
import { planCounts } from './counts.ts';
import { gateScope } from './gate.ts';
import type { ScanActor } from './guard.ts';
import { blankOutcome, safeDisplay, undoWindowMinutes } from './outcome.ts';
import { gateHolderStmt } from './repo-gates.ts';
import { candidateById } from './repo-lookup.ts';
import type { ScanRow } from './repo-scans.ts';
import { foundOf } from './resolve.ts';

const MINUTE = 60_000;

/**
 * A finished scan answered again for the same key (SA 7.2): the stored verdict with the current
 * counts and display, `replay: true`. Nothing is written. A heads-up that named a previous scan
 * names whoever holds the gate now.
 */
export async function replayOutcome(
  ctx: ServiceContext,
  actor: ScanActor,
  row: ScanRow,
): Promise<ScanOutcome> {
  const db = ctx.env.DB;
  const candidate = row.passId ? await candidateById(db, actor.orgId, row.passId) : null;
  const found = candidate ? await foundOf(ctx, candidate, actor) : null;
  if (found && row.direction)
    found.admission = (await planAdmission(ctx, actor, found, row.direction)).plan;
  const action = found?.scan.actions.find((a) => a.id === row.actionId) ?? null;
  const counts = planCounts(ctx, actor);
  const holder =
    found && action && (row.reason === 'already_done' || row.reason === 'cooldown')
      ? gateHolderStmt(db, {
          passId: found.pass.id,
          actionId: action.id,
          scope: gateScope(action, actor, row.at),
        })
      : null;
  const results = await db.batch([...(holder ? [holder] : []), ...counts.stmts]);
  const read = await counts.read(results.slice(holder ? 1 : 0));
  const kind = row.outcome ?? 'refused';
  const held = holder
    ? (results[0]?.results?.[0] as
        | {
            scan_id: string | null;
            at: number;
            scanner_name: string | null;
            staff_name: string | null;
            override_of: string | null;
          }
        | undefined)
    : undefined;
  const window = await undoWindowMinutes(ctx);
  return {
    ...blankOutcome(kind, read),
    scanId: row.id,
    kind,
    reason: row.reason as ScanReason | null,
    replay: true,
    action: action ? { id: action.id, label: action.label, kind: action.kind } : null,
    template: found?.ref ?? null,
    at: row.at,
    checkIn:
      found?.admission && row.direction
        ? completedAdmission(
            { ...found.admission, state: { ...found.admission.state, direction: row.direction } },
            row.at,
          )
        : undefined,
    previous:
      held?.scan_id && held.scan_id !== row.id
        ? {
            scanId: held.scan_id,
            at: held.at,
            scannerName: held.scanner_name ?? 'Scanner',
            staffName: held.staff_name,
            actionLabel: action?.label ?? 'Check in',
            override: held.override_of !== null,
          }
        : null,
    undoUntil: kind === 'ok' && row.undoneBy === null ? row.at + window * MINUTE : null,
    display:
      found && row.reason !== 'test_pass' && row.reason !== 'live_pass'
        ? safeDisplay(ctx, actor, found.pass, kind, { found })
        : null,
  };
}
