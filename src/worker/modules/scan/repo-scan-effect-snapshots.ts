import { type SqlValue, stmt } from '../../platform/db.ts';
import type { PresenceRow } from './admission-types.ts';
import type { GateKey } from './repo-gates.ts';
import type {
  ScanEffectSnapshot,
  ScanGateSnapshot,
  ScanPresenceSnapshot,
} from './repo-scan-effect.ts';

type Predicate = { sql: string; params: SqlValue[] };

export function presenceSnapshot(row: PresenceRow | null): ScanPresenceSnapshot | null {
  return (
    row && {
      passId: row.pass_id,
      orgId: row.org_id,
      scope: row.scope,
      state: row.state,
      tracking: row.tracking,
      enteredAt: row.entered_at,
      firstAt: row.first_at,
      lastEntryAt: row.last_entry_at,
      lastScanId: row.last_scan_id,
      prevState: row.prev_state,
      prevTracking: row.prev_tracking,
      prevEnteredAt: row.prev_entered_at,
      prevFirstAt: row.prev_first_at,
      prevLastEntryAt: row.prev_last_entry_at,
      prevScanId: row.prev_scan_id,
    }
  );
}

const gateFields = [
  ['g.pass_id', 'passId'],
  ['g.action_id', 'actionId'],
  ['g.scope', 'scope'],
  ['g.org_id', 'orgId'],
  ['g.mode', 'mode'],
  ['g.template_id', 'templateId'],
  ['g.kind', 'kind'],
  ['g.state', 'state'],
  ['g.count', 'count'],
  ['g.first_at', 'firstAt'],
  ['g.last_at', 'lastAt'],
  ['g.last_scan_id', 'lastScanId'],
  ['g.prev_state', 'prevState'],
  ['g.prev_last_at', 'prevLastAt'],
  ['g.prev_scan_id', 'prevScanId'],
  ['h.state', 'holderState'],
  ['h.undone_by', 'holderUndoneBy'],
] as const;
const presenceFields = [
  ['p.pass_id', 'passId'],
  ['p.org_id', 'orgId'],
  ['p.scope', 'scope'],
  ['p.state', 'state'],
  ['p.tracking', 'tracking'],
  ['p.entered_at', 'enteredAt'],
  ['p.first_at', 'firstAt'],
  ['p.last_entry_at', 'lastEntryAt'],
  ['p.last_scan_id', 'lastScanId'],
  ['p.prev_state', 'prevState'],
  ['p.prev_tracking', 'prevTracking'],
  ['p.prev_entered_at', 'prevEnteredAt'],
  ['p.prev_first_at', 'prevFirstAt'],
  ['p.prev_last_entry_at', 'prevLastEntryAt'],
  ['p.prev_scan_id', 'prevScanId'],
] as const;
const jsonObject = (fields: readonly (readonly [string, string])[]) =>
  `json_object(${fields.map(([column, key]) => `'${key}',${column}`).join(',')})`;
const matches = (fields: readonly (readonly [string, string])[]) =>
  fields
    .map(([column, key]) => `${column} IS json_extract(snapshot.value,'$.${key}')`)
    .join(' AND ');

export type ObservedScanEffect = Pick<ScanEffectSnapshot, 'gateBefore' | 'presenceBefore'>;
interface ScanEffectRow {
  gate: string | null;
  presence: string | null;
}

/** Both rows are observed by one bounded query, before the MAC is computed. */
export function readScanEffectStmt(
  db: D1Database,
  gate: GateKey,
  presenceScope: string,
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT (SELECT ${jsonObject(gateFields)} FROM scan_gates g
      LEFT JOIN scans h ON h.id=g.last_scan_id WHERE g.pass_id=?/* scan-ephemeral-pass-id */ AND g.action_id=?/* scan-ephemeral-action-id */ AND g.scope=?/* scan-ephemeral-event-scope */) AS gate,
      (SELECT ${jsonObject(presenceFields)} FROM scan_presence p WHERE p.pass_id=?/* scan-ephemeral-pass-id */ AND p.scope=?/* scan-ephemeral-event-scope */) AS presence`,
    [gate.passId, gate.actionId, gate.scope, gate.passId, presenceScope],
  );
}

function scanEffectFromRow(row: ScanEffectRow | null): ObservedScanEffect {
  if (!row) throw new Error('Missing scan effect snapshot');
  return {
    gateBefore: row.gate === null ? null : (JSON.parse(row.gate) as ScanGateSnapshot),
    presenceBefore:
      row.presence === null ? null : (JSON.parse(row.presence) as ScanPresenceSnapshot),
  };
}

/** Decode the matching statement result when the preflight is batched with other fences. */
export function scanEffectFromResult(result: D1Result | undefined): ObservedScanEffect {
  return scanEffectFromRow((result?.results?.[0] ?? null) as ScanEffectRow | null);
}

export async function readScanEffect(
  db: D1Database,
  gate: GateKey,
  presenceScope: string,
): Promise<ObservedScanEffect> {
  return scanEffectFromRow(
    await readScanEffectStmt(db, gate, presenceScope).first<ScanEffectRow>(),
  );
}

export function samePresence(
  a: ScanPresenceSnapshot | null,
  b: ScanPresenceSnapshot | null,
): boolean {
  if (a === null || b === null) return a === b;
  return presenceFields.every(([, key]) => a[key] === b[key]);
}

export function gateSnapshotPredicate(gate: GateKey, expected: ScanGateSnapshot | null): Predicate {
  const keys = [gate.passId, gate.actionId, gate.scope];
  const where =
    'g.pass_id=?/* scan-ephemeral-pass-id */ AND g.action_id=?/* scan-ephemeral-action-id */ AND g.scope=?/* scan-ephemeral-event-scope */';
  if (!expected)
    return { sql: `NOT EXISTS (SELECT 1 FROM scan_gates g WHERE ${where})`, params: keys };
  return {
    sql: `EXISTS (SELECT 1 FROM scan_gates g LEFT JOIN scans h ON h.id=g.last_scan_id
      CROSS JOIN (SELECT ?/* scan-ephemeral-gate-snapshot */ AS value) snapshot WHERE ${where} AND ${matches(gateFields)})`,
    params: [JSON.stringify(expected), ...keys],
  };
}

export function presenceSnapshotPredicate(
  passId: string,
  scope: string,
  expected: ScanPresenceSnapshot | null,
): Predicate {
  const where =
    'p.pass_id=?/* scan-ephemeral-pass-id */ AND p.scope=?/* scan-ephemeral-event-scope */';
  if (!expected)
    return {
      sql: `NOT EXISTS (SELECT 1 FROM scan_presence p WHERE ${where})`,
      params: [passId, scope],
    };
  return {
    sql: `EXISTS (SELECT 1 FROM scan_presence p CROSS JOIN (SELECT ?/* scan-ephemeral-presence-snapshot */ AS value) snapshot
      WHERE ${where} AND ${matches(presenceFields)})`,
    params: [JSON.stringify(expected), passId, scope],
  };
}

export function effectPredicate(
  gate: GateKey,
  presenceScope: string,
  gateState: ScanGateSnapshot | null,
  presence: ScanPresenceSnapshot | null,
): Predicate {
  const g = gateSnapshotPredicate(gate, gateState);
  const p = presenceSnapshotPredicate(gate.passId, presenceScope, presence);
  return { sql: `(${g.sql}) AND (${p.sql})`, params: [...g.params, ...p.params] };
}
