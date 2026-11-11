import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { exists, type GrantCond } from '../../platform/authority-cond.ts';
import { lte, ne, type WhereValue } from '../../platform/authority-expr.ts';
import type { EventRow } from '../events/repo.ts';
import type { GateRule } from './repo-gates.ts';
import type { ScanGateSnapshot, ScanPresenceSnapshot } from './repo-scan-effect.ts';
import { wonGate } from './scan-write-grant.ts';

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

/** Close this pending generation. Zero rows come back when the claim moved or another variant already closed it. */
export function finalizeScan(g: Grant, f: Finalize, when: GrantCond[] = []): GrantedStatement {
  return g.update('scans', {
    set: {
      state: 'done',
      outcome: f.outcome,
      reason: f.reason,
      pass_id: f.passId,
      template_id: f.templateId,
      action_id: f.actionId,
      action_kind: f.actionKind,
      pass_version: f.passVersion,
      override_of: f.overrideOf,
      approved_by: f.approvedBy,
      direction: f.direction ?? null,
      presence_scope: f.presenceScope ?? null,
      ...(f.eventId ? { event_id: f.eventId } : {}),
    },
    where: { id: f.id, state: 'pending', at: f.claimAt },
    when,
    returning: ['id'],
  });
}

/** The pre-signed ledger row, only if the scan closed with this outcome (and reason). */
export function ledgerEvent(
  g: Grant,
  row: EventRow,
  scanId: string,
  outcome: string,
  reason: string | null,
): GrantedStatement {
  return g.insertSelect(
    'pass_events',
    ['id', 'pass_id', 'kind', 'device', 'actor_type', 'actor_id', 'data', 'at'],
    [row.id, row.pass_id, row.kind, row.device, row.actor_type, row.actor_id, row.data, row.at],
    { when: [exists('scans', { id: scanId, state: 'done', outcome, reason })], returning: ['id'] },
  );
}

export interface GateWrite {
  passId: string;
  actionId: string;
  scope: string;
  templateId: string;
  kind: string;
  scanId: string;
  rule: GateRule;
  /** The clock the cooldown is judged at. */
  at: number;
  before: ScanGateSnapshot | null;
  after: ScanGateSnapshot;
}

/** First scan wins: insert, or take over the observed row when the rule lets this scan through. */
export function writeGate(g: Grant, w: GateWrite, when: GrantCond[]): GrantedStatement {
  const { after } = w;
  const columns = [
    'pass_id',
    'action_id',
    'scope',
    'template_id',
    'kind',
    'state',
    'count',
    'first_at',
    'last_at',
    'last_scan_id',
  ];
  const values = [
    w.passId,
    w.actionId,
    w.scope,
    w.templateId,
    w.kind,
    after.state,
    1,
    after.firstAt,
    after.lastAt,
    w.scanId,
  ];
  const base = { when, returning: ['last_scan_id'] };
  if (!w.before) return g.upsert('scan_gates', columns, values, { ...base, doNothing: true });
  const rule: Record<string, WhereValue> =
    w.rule.rule === 'once'
      ? { state: 'undone' }
      : w.rule.rule === 'cooldown'
        ? { last_at: lte(w.at - w.rule.cooldownMs) }
        : {};
  return g.upsert('scan_gates', columns, values, {
    ...base,
    copy: { prev_state: 'state', prev_last_at: 'last_at', prev_scan_id: 'last_scan_id' },
    update: ['state', 'last_at', 'last_scan_id'],
    inc: ['count'],
    where: { ...rule, last_scan_id: ne(w.scanId) },
  });
}

/** Presence follows the gate: written only when this scan holds it. */
export function writePresence(
  g: Grant,
  gate: { passId: string; actionId: string; scope: string },
  scanId: string,
  before: ScanPresenceSnapshot | null,
  after: ScanPresenceSnapshot,
): GrantedStatement {
  const columns = [
    'pass_id',
    'scope',
    'state',
    'tracking',
    'entered_at',
    'first_at',
    'last_entry_at',
    'last_scan_id',
  ];
  const values = [
    after.passId,
    after.scope,
    after.state,
    after.tracking,
    after.enteredAt,
    after.firstAt,
    after.lastEntryAt,
    scanId,
  ];
  const when = [wonGate(gate, scanId)];
  if (!before) return g.upsert('scan_presence', columns, values, { when, doNothing: true });
  return g.upsert('scan_presence', columns, values, {
    when,
    copy: {
      prev_state: 'state',
      prev_tracking: 'tracking',
      prev_entered_at: 'entered_at',
      prev_first_at: 'first_at',
      prev_last_entry_at: 'last_entry_at',
      prev_scan_id: 'last_scan_id',
    },
    update: [
      'state',
      'tracking',
      'entered_at',
      'last_scan_id',
      ...(after.state === 'in' ? ['last_entry_at'] : []),
    ],
    where: { last_scan_id: before.lastScanId },
  });
}
