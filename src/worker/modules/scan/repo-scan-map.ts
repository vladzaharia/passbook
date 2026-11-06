import type { Mode } from '../../../shared/contracts/common.ts';

export interface ScanRow {
  id: string;
  orgId: string;
  mode: Mode;
  passId: string | null;
  templateId: string | null;
  scannerId: string | null;
  eventId: string | null;
  actorKey: string;
  staffId: string | null;
  requestHash: string;
  state: 'pending' | 'done' | 'failed';
  outcome: 'ok' | 'heads_up' | 'refused' | null;
  reason: string | null;
  actionId: string | null;
  actionKind: string | null;
  overrideOf: string | null;
  approvedBy: string | null;
  passVersion: number | null;
  method: string;
  at: number;
  undoneBy: string | null;
  direction?: 'in' | 'out' | null;
  presenceScope?: string | null;
}

export interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  pass_id: string | null;
  template_id: string | null;
  scanner_id: string | null;
  event_id: string | null;
  actor_key: string;
  staff_id: string | null;
  request_hash: string;
  state: ScanRow['state'];
  outcome: ScanRow['outcome'];
  reason: string | null;
  action_id: string | null;
  action_kind: string | null;
  override_of: string | null;
  approved_by: string | null;
  pass_version: number | null;
  method: string;
  at: number;
  undone_by: string | null;
  direction: 'in' | 'out' | null;
  presence_scope: string | null;
}

export const toScan = (r: Raw): ScanRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  passId: r.pass_id,
  templateId: r.template_id,
  scannerId: r.scanner_id,
  eventId: r.event_id,
  actorKey: r.actor_key,
  staffId: r.staff_id,
  requestHash: r.request_hash,
  state: r.state,
  outcome: r.outcome,
  reason: r.reason,
  actionId: r.action_id,
  actionKind: r.action_kind,
  overrideOf: r.override_of,
  approvedBy: r.approved_by,
  passVersion: r.pass_version,
  method: r.method,
  at: r.at,
  undoneBy: r.undone_by,
  direction: r.direction,
  presenceScope: r.presence_scope,
});
