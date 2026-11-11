import type { Mode } from '../../../shared/contracts/common.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';
import { type GateKey, wonGate } from './repo-gates.ts';

type Db = D1Database;

export interface Claim {
  id: string;
  orgId: string;
  mode: Mode;
  scannerId: string | null;
  eventId: string | null;
  actorType: 'scanner' | 'user';
  actorId: string;
  actorKey: string;
  staffId: string | null;
  idempotencyKey: string;
  requestHash: string;
  method: string;
  clientTs: number;
  now: number;
}

/** Claim the key only while the optional original authority remains current. */
export function claimScanStmt(
  db: Db,
  c: Claim,
  guard?: { sql: string; params: readonly SqlValue[] },
): D1PreparedStatement {
  const bound = guard ?? { sql: '1', params: [] };
  return stmt(
    db,
    `INSERT INTO scans (id, org_id, mode, scanner_id, event_id, actor_type, actor_id, actor_key, staff_id,
       idempotency_key, request_hash, method, state, client_ts, at)
     SELECT ?/* scan-ephemeral-scan-id */, ?, ?, ?/* scan-ephemeral-scanner-id */, ?/* scan-ephemeral-event-id */, ?, ?/* scan-ephemeral-actor-id */, ?/* scan-ephemeral-actor-key */, ?/* scan-ephemeral-staff-id */, ?/* scan-ephemeral-idempotency-key */, ?/* scan-ephemeral-request-hash */, ?, 'pending', ?, ?
     WHERE (${bound.sql}) ON CONFLICT (actor_key, idempotency_key) DO NOTHING RETURNING id`,
    [
      c.id,
      c.orgId,
      c.mode,
      c.scannerId,
      c.eventId,
      c.actorType,
      c.actorId,
      c.actorKey,
      c.staffId,
      c.idempotencyKey,
      c.requestHash,
      c.method,
      c.clientTs,
      c.now,
      ...bound.params,
    ],
  );
}

export async function claimScan(db: Db, c: Claim): Promise<boolean> {
  return (await claimScanStmt(db, c).first<{ id: string }>()) !== null;
}

export interface Finalize {
  id: string;
  claimAt: number;
  outcome: 'ok' | 'heads_up' | 'refused';
  reason: string | null;
  passId: string | null;
  templateId: string | null;
  actionId: string | null;
  actionKind: string | null;
  passVersion: number | null;
  overrideOf: string | null;
  approvedBy: string | null;
  direction?: 'in' | 'out';
  presenceScope?: string;
  eventId?: string;
}

type Predicate = { sql: string; params: readonly SqlValue[] };
type WriteGuard = Predicate | { parts: readonly Predicate[] };

const guardOf = (guard: WriteGuard | undefined): Predicate =>
  !guard
    ? { sql: '1', params: [] }
    : 'sql' in guard
      ? guard
      : {
          sql: guard.parts.map((p) => `(${p.sql})`).join(' AND ') || '1',
          params: guard.parts.flatMap((p) => p.params),
        };

/** Close only this pending generation, optionally while its gate is held. Kept for the reconcile job's tests; the door writes through a grant. */
export function finalizeStmt(
  db: Db,
  f: Finalize,
  won?: GateKey,
  extra?: WriteGuard,
): D1PreparedStatement {
  const gate = won ? wonGate(won, f.id) : null;
  const guard = guardOf(extra);
  return stmt(
    db,
    `UPDATE scans SET state = 'done', outcome = ?, reason = ?, pass_id = ?/* scan-ephemeral-pass-id */,
       template_id = ?/* scan-ephemeral-template-id */, action_id = ?/* scan-ephemeral-action-id */,
       action_kind = ?, pass_version = ?, override_of = ?/* scan-ephemeral-scan-id */,
       approved_by = ?/* scan-ephemeral-approver-id */, direction = ?, presence_scope = ?/* scan-ephemeral-event-scope */,
       event_id = COALESCE(?/* scan-ephemeral-event-id */,event_id)
     WHERE (id = ?/* scan-ephemeral-scan-id */ AND state = 'pending' AND at = ?)${
       gate
         ? ` AND ${gate.sql}`
         : ` AND NOT EXISTS (SELECT 1 FROM scan_gates g WHERE g.last_scan_id = scans.id OR g.prev_scan_id = scans.id)`
     } AND (${guard.sql})
     RETURNING id`,
    [
      f.outcome,
      f.reason,
      f.passId,
      f.templateId,
      f.actionId,
      f.actionKind,
      f.passVersion,
      f.overrideOf,
      f.approvedBy,
      f.direction,
      f.presenceScope,
      f.eventId,
      f.id,
      f.claimAt,
      ...(gate?.params ?? []),
      ...guard.params,
    ],
  );
}

/** Insert the pre-signed event after a guarded finalize (reconcile tests only). */
export function ledgerIfFinalizedStmt(
  db: Db,
  row: EventRow,
  scanId: string,
  claimAt: number,
  outcome: 'ok' | 'refused' | 'heads_up',
  extra: WriteGuard,
  won?: GateKey,
): D1PreparedStatement {
  const guard = guardOf(extra);
  return stmt(
    db,
    `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, device, actor_type, actor_id, data, at)
     SELECT ?/* scan-ephemeral-event-id */, ?, ?/* scan-ephemeral-pass-id */, ?, ?, ?/* scan-ephemeral-event-device */, ?, ?/* scan-ephemeral-event-actor */, ?/* scan-ephemeral-event-json */, ?
     ${won ? 'FROM scan_gates g JOIN scans holder ON holder.id = g.last_scan_id' : ''}
     WHERE ${won ? '(g.pass_id = ?/* scan-ephemeral-pass-id */ AND g.action_id = ?/* scan-ephemeral-action-id */ AND g.scope = ?/* scan-ephemeral-event-scope */ AND g.last_scan_id = ?/* scan-ephemeral-scan-id */) AND ' : ''}changes() = 1 AND EXISTS (
       SELECT 1 FROM scans q WHERE (q.id = ?/* scan-ephemeral-scan-id */ AND q.org_id = ?
         AND q.state = 'done') AND (q.at = ? AND q.pass_id = ?/* scan-ephemeral-pass-id */ AND q.outcome = ?)
     ) AND (${guard.sql})`,
    [
      row.id,
      row.org_id,
      row.pass_id,
      row.mode,
      row.kind,
      row.device,
      row.actor_type,
      row.actor_id,
      row.data,
      row.at,
      ...(won ? [won.passId, won.actionId, won.scope, scanId] : []),
      scanId,
      row.org_id,
      claimAt,
      row.pass_id,
      outcome,
      ...guard.params,
    ],
  );
}
