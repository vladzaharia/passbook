import type { Mode } from '../../../shared/contracts/common.ts';
import type { EventRow } from '../events/repo.ts';
import type { ScanEventReference } from './scan-event-proof.ts';

/** One row of the history page statement (`repo-history-rows.ts`), exactly as D1 returns it. */
export interface HistoryRaw {
  id: string;
  org_id: string;
  mode: Mode;
  at: number;
  outcome: 'ok' | 'heads_up' | 'refused' | null;
  reason: string | null;
  action_id: string | null;
  action_kind: string | null;
  direction: 'in' | 'out' | null;
  pass_id: string | null;
  template_id: string | null;
  template_name: string | null;
  actor_key: string;
  scan_state: ScanEventReference['state'];
  raw_scanner_id: string | null;
  raw_event_id: string | null;
  raw_staff_id: string | null;
  api_key_id: string | null;
  raw_undone_by: string | null;
  presence_scope: string | null;
  pass_version: number | null;
  event_id: string | null;
  event_name: string | null;
  scanner_id: string | null;
  scanner_name: string | null;
  staff_id: string | null;
  staff_name: string | null;
  approver_name: string | null;
  method: 'camera' | 'wedge' | 'nfc' | 'manual' | 'auto';
  amount: number | null;
  before_value: string | null;
  after_value: string | null;
  override_of: string | null;
  offline: number;
  /** 1 when the offline read that made this scan was dated before its door's contact or list. */
  late?: number;
  actor_type: 'scanner' | 'user' | 'system';
  actor_id: string;
  undone_at: number | null;
  undone_by: string | null;
  undoes: string | null;
  undone_by_name: string | null;
  /** Scans one group request made, on its anchor row; 0 elsewhere. */
  group_size: number;
  passless_candidate: number;
  retention_candidate: number;
  has_ledger: number;
  has_recorded: number;
  has_recorded_template: number;
  release_class: string | null;
  lineage_ok: number;
  approved_proof: number;
  legacy_proof: number;
  pass_ok: number;
  policy_extra_ok: number;
  projection_extra_ok: number;
  wallet_ok: number;
  transfer_pending: number;
  recorded_wallet_version: number | null;
  recorded_wallet_template_version: string | null;
  recorded_personalization: string | null;
  event_pinned_version: string | null;
  event_active_version: string | null;
  current_pinned_version: string | null;
  current_active_version: string | null;
  current_personalization: string | null;
  current_credential_generation: number | null;
  current_lifecycle_generation: number | null;
  pass_serial: string | null;
  pass_auth_token: string | null;
  pass_download_token: string | null;
  pass_web_service_url: string | null;
  pass_scan_code: string | null;
  pass_external_id: string | null;
  pass_holder_email: string | null;
  current_wallet_private_values: string | null;
  ledger_id: string | null;
  ledger_org_id: string | null;
  ledger_pass_id: string | null;
  ledger_mode: EventRow['mode'] | null;
  ledger_kind: EventRow['kind'] | null;
  ledger_device: string | null;
  ledger_actor_type: string | null;
  ledger_actor_id: string | null;
  ledger_data: string | null;
  ledger_at: number | null;
}

/**
 * One `scans` row with the names the console shows and the facts its disclosure rests on, all read
 * in one snapshot. Nothing here is trusted until `history-row-evidence.ts` verifies the event.
 */
export interface HistoryRow {
  id: string;
  orgId: string;
  mode: Mode;
  at: number;
  outcome: HistoryRaw['outcome'];
  reason: string | null;
  actionId: string | null;
  actionKind: string | null;
  direction: 'in' | 'out' | null;
  passId: string | null;
  /** An indexed null-pass tombstone candidate; it permits only minimal ledger metadata. */
  retentionCandidate: boolean;
  /** A scope-matched refusal that selected no pass. */
  passlessProofCandidate: boolean;
  /** The pass-side and recorded-side checks of this snapshot passed. Set by `provenanceChecked`. */
  policyAvailable: boolean;
  /** The signed pass event this scan names, when one is stored. */
  ledger: EventRow | null;
  templateId: string | null;
  templateName: string | null;
  eventId: string | null;
  eventName: string | null;
  scannerId: string | null;
  scannerName: string | null;
  staffId: string | null;
  staffName: string | null;
  apiKeyId: string | null;
  approvedBy: string | null;
  method: HistoryRaw['method'];
  amount: number | null;
  before: string | null;
  after: string | null;
  passVersion: number | null;
  override: boolean;
  offline: boolean;
  /** Let in on staff's word with no list; the server checked it afterwards. */
  unverified: boolean;
  /** A back-dated offline read, taken at server time. */
  late: boolean;
  actorType: HistoryRaw['actor_type'];
  actorId: string;
  undoneAt: number | null;
  undoneBy: string | null;
  undoes: string | null;
  raw: HistoryRaw;
}

const on = (value: number) => value === 1;

/** The old `policy_candidate`: a passless scan, or a current pass whose recorded proof agrees. */
export function policyCandidateOf(raw: HistoryRaw): boolean {
  if (on(raw.passless_candidate)) return true;
  if (!on(raw.pass_ok) || !on(raw.policy_extra_ok) || !on(raw.wallet_ok)) return false;
  if (!on(raw.has_ledger) || !on(raw.has_recorded) || !on(raw.has_recorded_template)) return false;
  if (!on(raw.lineage_ok)) return false;
  return (
    (raw.release_class === 'approved' && on(raw.approved_proof)) ||
    (raw.release_class === 'legacy' && on(raw.legacy_proof))
  );
}

/** The old proof read's `projection_current`: the pass may still be projected. */
export function projectionCurrentOf(raw: HistoryRaw): boolean {
  return (
    on(raw.pass_ok) &&
    on(raw.projection_extra_ok) &&
    on(raw.wallet_ok) &&
    on(raw.lineage_ok) &&
    on(raw.has_ledger)
  );
}

function ledgerOf(raw: HistoryRaw): EventRow | null {
  if (
    raw.ledger_id === null ||
    raw.ledger_org_id === null ||
    raw.ledger_pass_id === null ||
    raw.ledger_mode === null ||
    raw.ledger_kind === null ||
    raw.ledger_data === null ||
    raw.ledger_at === null
  )
    return null;
  return {
    id: raw.ledger_id,
    org_id: raw.ledger_org_id,
    pass_id: raw.ledger_pass_id,
    mode: raw.ledger_mode,
    kind: raw.ledger_kind,
    device: raw.ledger_device,
    actor_type: raw.ledger_actor_type,
    actor_id: raw.ledger_actor_id,
    data: raw.ledger_data,
    at: raw.ledger_at,
  };
}

export const toHistoryRow = (r: HistoryRaw): HistoryRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  at: r.at,
  outcome: r.outcome,
  reason: r.reason,
  actionId: r.action_id,
  actionKind: r.action_kind,
  direction: r.direction,
  passId: r.pass_id,
  retentionCandidate: on(r.retention_candidate),
  passlessProofCandidate: on(r.passless_candidate),
  policyAvailable: false,
  ledger: ledgerOf(r),
  templateId: r.template_id,
  templateName: r.template_name,
  eventId: r.event_id,
  eventName: r.event_name,
  scannerId: r.scanner_id,
  scannerName: r.scanner_name,
  staffId: r.staff_id,
  staffName: r.staff_name,
  apiKeyId: r.api_key_id,
  approvedBy: r.approver_name,
  method: r.method,
  amount: r.amount,
  before: r.before_value,
  after: r.after_value,
  passVersion: r.pass_version,
  override: r.override_of !== null,
  offline: on(r.offline),
  unverified: r.offline === 2,
  late: r.late === 1,
  actorType: r.actor_type,
  actorId: r.actor_id,
  undoneAt: r.undone_at,
  undoneBy: r.undone_by_name ?? (r.undone_by ? 'Unknown' : null),
  undoes: r.undoes,
  raw: r,
});

/** The scan as the event MAC names it. Null until the recorded Wallet and template versions exist. */
export function scanReferenceOf(
  raw: HistoryRaw,
): (ScanEventReference & { undoneBy: string | null }) | null {
  if (
    raw.pass_id === null ||
    raw.event_pinned_version === null ||
    raw.recorded_wallet_version === null ||
    !Number.isSafeInteger(raw.recorded_wallet_version)
  )
    return null;
  return {
    id: raw.id,
    orgId: raw.org_id,
    mode: raw.mode,
    passId: raw.pass_id,
    templateId: raw.template_id,
    scannerId: raw.raw_scanner_id,
    eventId: raw.raw_event_id,
    actorKey: raw.actor_key,
    staffId: raw.raw_staff_id,
    actionId: raw.action_id,
    actionKind: raw.action_kind,
    outcome: raw.outcome,
    reason: raw.reason,
    passVersion: raw.pass_version,
    method: raw.method,
    at: raw.at,
    state: raw.scan_state,
    pinnedTemplateVersion: raw.event_pinned_version,
    walletVersion: raw.recorded_wallet_version,
    walletTemplateVersion: raw.recorded_wallet_template_version,
    direction: raw.direction,
    presenceScope: raw.presence_scope,
    undoneBy: raw.raw_undone_by,
  };
}
