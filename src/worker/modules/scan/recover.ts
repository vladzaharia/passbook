import type { Json } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sanitizeEventData } from '../events/record.ts';
import type { EventRow } from '../events/repo.ts';
import { gateOfScanStmt, passVersionStmt, releaseGateStmts } from './repo-gates.ts';
import { failScanStmt, finalizeStmt, ledgerIfWonStmt, type ScanRow } from './repo-scans.ts';

/** The ledger row of a check-in that reconcile finishes: what the scan row alone can tell. */
function ledgerFor(ctx: ServiceContext, row: ScanRow, version: number): EventRow {
  const at = ctx.clock.now();
  const [kind, id] = row.actorKey.split(':');
  const data: Record<string, Json> = {
    scanId: row.id,
    actionId: row.actionId,
    actionKind: row.actionKind,
    outcome: 'ok',
    reason: null,
    method: row.method,
    version,
    eventId: row.eventId,
    scannerId: row.scannerId,
    staffId: row.staffId,
    approvedBy: row.approvedBy,
    override: row.overrideOf !== null,
    offline: false,
    notified: false,
  };
  return {
    id: ctx.ids.ordered(at),
    org_id: row.orgId,
    pass_id: row.passId ?? '',
    mode: row.mode,
    kind: 'scan.checked_in',
    device: null,
    actor_type: kind === 's' ? 'scanner' : 'user',
    actor_id: id ?? null,
    data: JSON.stringify(sanitizeEventData(data)),
    at,
  };
}

/**
 * Settles pending scans that never finished (SA 9.3). A check-in whose gate points at it won:
 * finalize it `ok` with its ledger row. A scan that never took a gate failed. A value action that
 * took the gate but never committed (`pass_version` empty) gives the gate back and fails.
 */
export async function recoverScans(
  ctx: ServiceContext,
  rows: ScanRow[],
): Promise<{ finished: number; failed: number }> {
  const db = ctx.env.DB;
  const open = rows.filter((r) => r.passId && r.actionId);
  const probes = open.length
    ? await db.batch(
        open.flatMap((r) => [
          gateOfScanStmt(db, r.passId ?? '', r.actionId ?? '', r.id),
          passVersionStmt(db, r.passId ?? ''),
        ]),
      )
    : [];
  const statements: D1PreparedStatement[] = [];
  let finished = 0;
  let failed = 0;
  for (const row of rows) {
    const at = open.indexOf(row);
    const scope = (probes[at * 2]?.results?.[0] as { scope: string } | undefined)?.scope;
    const version = (probes[at * 2 + 1]?.results?.[0] as { version: number } | undefined)?.version;
    const gate =
      scope === undefined
        ? null
        : { passId: row.passId ?? '', actionId: row.actionId ?? '', scope };
    const committed = gate !== null && (row.actionKind === 'check_in' || row.passVersion !== null);
    if (gate && committed) {
      const final = {
        id: row.id,
        outcome: 'ok' as const,
        reason: null,
        passId: row.passId,
        templateId: row.templateId,
        actionId: row.actionId,
        actionKind: row.actionKind,
        passVersion: row.passVersion ?? version ?? null,
        overrideOf: row.overrideOf,
        approvedBy: row.approvedBy,
      };
      statements.push(finalizeStmt(db, final, row.actionKind === 'check_in' ? gate : undefined));
      if (row.actionKind === 'check_in')
        statements.push(ledgerIfWonStmt(db, ledgerFor(ctx, row, version ?? 0), gate, row.id));
      finished++;
    } else {
      if (gate) statements.push(...releaseGateStmts(db, gate, row.id));
      statements.push(failScanStmt(db, row.id));
      failed++;
    }
  }
  if (statements.length > 0) await db.batch(statements);
  return { finished, failed };
}
