import type { ServiceContext } from '../../platform/service-context.ts';
import {
  type GateSnapshot,
  gatesOfScansStmt,
  quarantinePreviousClaimStmt,
  releaseObservedGateStmt,
} from './repo-gate-recovery.ts';
import { failScanStmt, presenceOfScansStmt, type ScanRow } from './repo-scans.ts';

/**
 * A pending row or a gate pointer cannot prove that admission committed. Quarantine ambiguous
 * claims, undoing only unchanged gate snapshots; a pristine claim can safely be retried.
 */
export async function recoverScans(
  ctx: ServiceContext,
  rows: ScanRow[],
): Promise<{ finished: number; failed: number }> {
  const db = ctx.env.DB;
  const pending = rows.filter((row) => row.state === 'pending');
  if (pending.length === 0) return { finished: 0, failed: 0 };

  const ids = pending.map((row) => row.id);
  const [probe, presenceProbe] = await db.batch([
    gatesOfScansStmt(db, ids),
    presenceOfScansStmt(db, ids),
  ]);
  const gates = new Map(pending.map((row) => [row.id, [] as GateSnapshot[]]));
  for (const gate of (probe?.results ?? []) as unknown as GateSnapshot[]) {
    gates.get(gate.last_scan_id)?.push(gate);
    if (gate.prev_scan_id !== null && gate.prev_scan_id !== gate.last_scan_id)
      gates.get(gate.prev_scan_id)?.push(gate);
  }
  const presence = new Set<string>();
  for (const row of (presenceProbe?.results ?? []) as unknown as {
    last_scan_id: string;
    prev_scan_id: string | null;
  }[]) {
    presence.add(row.last_scan_id);
    if (row.prev_scan_id !== null) presence.add(row.prev_scan_id);
  }

  const statements: D1PreparedStatement[] = [];
  const failures: number[] = [];
  for (const row of pending) {
    const observed = gates.get(row.id) ?? [];
    for (const gate of observed) {
      if (gate.last_scan_id !== row.id) continue;
      const previous = quarantinePreviousClaimStmt(db, gate);
      if (previous) {
        failures.push(statements.length);
        statements.push(previous);
      }
      const release = releaseObservedGateStmt(db, gate, row.at);
      if (release) statements.push(release);
    }
    failures.push(statements.length);
    statements.push(
      failScanStmt(db, row.id, {
        at: row.at,
        observedAmbiguous:
          observed.length > 0 ||
          presence.has(row.id) ||
          row.passId !== null ||
          row.templateId !== null ||
          row.actionId !== null ||
          row.actionKind !== null ||
          row.passVersion !== null ||
          row.outcome !== null ||
          row.reason !== null ||
          row.overrideOf !== null ||
          row.approvedBy !== null ||
          row.undoneBy !== null ||
          row.direction != null ||
          row.presenceScope != null,
      }),
    );
  }
  const results = await db.batch(statements);
  return {
    finished: 0,
    failed: failures.filter((index) => (results[index]?.results?.length ?? 0) > 0).length,
  };
}
