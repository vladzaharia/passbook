import type { EventRow } from '../events/repo.ts';
import type { Raw, ScanKeySnapshot, ScanLogRow } from './repo-feed-types.ts';

function eventProofOf(r: Raw): ScanLogRow['eventProof'] {
  if (
    r.policy_candidate !== 1 ||
    !r.pass_id ||
    !r.proof_event ||
    !r.recorded_template_version ||
    r.recorded_wallet_version === null ||
    !Number.isSafeInteger(r.recorded_wallet_version)
  )
    return null;
  return {
    event: JSON.parse(r.proof_event) as EventRow,
    currentPersonalization: r.current_personalization,
    versionPersonalization: r.version_personalization,
    eventPinnedManifest: r.event_pinned_manifest,
    eventWalletVersion: r.event_wallet_version,
    eventWalletManifest: r.event_wallet_manifest,
    eventActiveVersion: r.event_active_version,
    eventActiveManifest: r.event_active_manifest,
    eventLegacyVersion: r.event_legacy_version,
    eventLegacyManifest: r.event_legacy_manifest,
    scan: {
      id: r.id,
      orgId: r.org_id,
      mode: r.mode,
      passId: r.pass_id,
      templateId: r.template_id,
      scannerId: r.proof_scanner_id,
      eventId: r.proof_event_id,
      actorKey: r.proof_actor_key,
      staffId: r.proof_staff_id,
      actionId: r.action_id,
      actionKind: r.action_kind,
      outcome: r.outcome,
      reason: r.reason,
      passVersion: r.pass_version,
      method: r.method,
      at: r.at,
      state: r.proof_state,
      pinnedTemplateVersion: r.recorded_template_version,
      walletVersion: r.recorded_wallet_version,
      walletTemplateVersion: r.recorded_wallet_template_version,
      direction: r.direction,
      presenceScope: r.proof_presence_scope,
    },
  };
}

export const toRow = (r: Raw): ScanLogRow => ({
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
  retentionCandidate: r.retention_candidate === 1,
  passlessProofCandidate: r.passless_proof_candidate === 1,
  policyAvailable: false,
  eventProof: eventProofOf(r),
  keySnapshot: r.key_snapshot ? (JSON.parse(r.key_snapshot) as ScanKeySnapshot) : null,
  source: {
    state: r.proof_state,
    actorKey: r.proof_actor_key,
    scannerId: r.proof_scanner_id,
    eventId: r.proof_event_id,
    staffId: r.proof_staff_id,
    approvedBy: r.proof_approved_by,
    overrideOf: r.proof_override_of,
    undoes: r.proof_undoes,
    undoneBy: r.proof_undone_by,
    presenceScope: r.proof_presence_scope,
  },
  templateId: r.template_id,
  templateName: r.template_name,
  eventId: r.event_id,
  eventName: r.event_name,
  scannerId: r.scanner_id,
  scannerName: r.scanner_name,
  staffId: r.staff_id,
  staffName: r.staff_name,
  approvedBy: r.approver_name,
  method: r.method,
  amount: r.amount,
  before: r.before_value,
  after: r.after_value,
  passVersion: r.pass_version,
  override: r.override_of !== null,
  offline: r.offline === 1,
  actorType: r.actor_type,
  actorId: r.actor_id,
  undoneAt: r.undone_at,
  undoneBy: r.undone_by_name ?? (r.undone_by ? 'Unknown' : null),
  undoes: r.undoes,
});
