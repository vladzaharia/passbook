import type { Mode } from '../../../shared/contracts/common.ts';
import type { EventRow } from '../events/repo.ts';
import type { ScanEventReference } from './scan-event-proof.ts';

/** Original event and immutable policy inputs; none are trusted until the proof is verified. */
export interface ScanEventProof {
  event: EventRow;
  scan: ScanEventReference;
  currentPersonalization: string | null;
  versionPersonalization: string | null;
  eventPinnedManifest: string | null;
  eventWalletVersion: string | null;
  eventWalletManifest: string | null;
  eventActiveVersion: string | null;
  eventActiveManifest: string | null;
  eventLegacyVersion: string | null;
  eventLegacyManifest: string | null;
}

/** Revision and authority stamps used for opaque API-key fields; no Wallet document is captured. */
export interface ScanKeySnapshot {
  passId: string;
  orgId: string;
  mode: Mode;
  templateId: string;
  templateVersion: string;
  issuanceReleaseId: string | null;
  passVersion: number;
  passRevision: number;
  credentialGeneration: number;
  lifecycleGeneration: number;
  linkGeneration: number;
  identityId: string;
  identityRevision: number | null;
  connectionId: string | null;
  connectionGeneration: number | null;
  orgRevision: number | null;
  headId: string | null;
  headGeneration: number | null;
  headVersion: string | null;
  headCandidateHash: string | null;
  walletVersion: number | null;
  walletTemplateVersion: string | null;
}

/** One `scans` row with the names the console shows. Pass identity is projected by the service. */
export interface ScanLogRow {
  id: string;
  orgId: string;
  mode: Mode;
  at: number;
  outcome: 'ok' | 'heads_up' | 'refused' | null;
  reason: string | null;
  actionId: string | null;
  actionKind: string | null;
  direction: 'in' | 'out' | null;
  passId: string | null;
  /** An indexed null-pass tombstone candidate; it permits only minimal ledger metadata. */
  retentionCandidate: boolean;
  /** An immutable, scope-matched no-pass index candidate. */
  passlessProofCandidate: boolean;
  /** Set only after the relevant provenance has been verified. */
  policyAvailable: boolean;
  /** Unverified event evidence; callers must verify before exposing pass-derived data. */
  eventProof: ScanEventProof | null;
  /** Internal compact source stamps for a roleless key output fence. */
  keySnapshot: ScanKeySnapshot | null;
  /** Raw ledger linkage retained only for same-snapshot output revalidation. */
  source: {
    state: ScanEventReference['state'];
    actorKey: string;
    scannerId: string | null;
    eventId: string | null;
    staffId: string | null;
    approvedBy: string | null;
    overrideOf: string | null;
    undoes: string | null;
    undoneBy: string | null;
    presenceScope: string | null;
  };
  templateId: string | null;
  templateName: string | null;
  eventId: string | null;
  eventName: string | null;
  scannerId: string | null;
  scannerName: string | null;
  staffId: string | null;
  staffName: string | null;
  approvedBy: string | null;
  method: 'camera' | 'wedge' | 'nfc' | 'manual' | 'auto';
  amount: number | null;
  before: string | null;
  after: string | null;
  passVersion: number | null;
  override: boolean;
  offline: boolean;
  actorType: 'scanner' | 'user' | 'system';
  actorId: string;
  undoneAt: number | null;
  undoneBy: string | null;
  undoes: string | null;
}

export interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  at: number;
  outcome: ScanLogRow['outcome'];
  reason: string | null;
  action_id: string | null;
  action_kind: string | null;
  direction: 'in' | 'out' | null;
  pass_id: string | null;
  retention_candidate: number;
  passless_proof_candidate: number;
  policy_candidate: number;
  key_snapshot: string | null;
  proof_event: string | null;
  recorded_template_version: string | null;
  recorded_wallet_version: number | null;
  recorded_wallet_template_version: string | null;
  event_wallet_version: string | null;
  event_wallet_manifest: string | null;
  current_personalization: string | null;
  version_personalization: string | null;
  event_pinned_manifest: string | null;
  event_active_version: string | null;
  event_active_manifest: string | null;
  event_legacy_version: string | null;
  event_legacy_manifest: string | null;
  proof_actor_key: string;
  proof_state: ScanEventReference['state'];
  proof_scanner_id: string | null;
  proof_event_id: string | null;
  proof_staff_id: string | null;
  proof_approved_by: string | null;
  proof_override_of: string | null;
  proof_undoes: string | null;
  proof_undone_by: string | null;
  proof_presence_scope: string | null;
  template_id: string | null;
  template_name: string | null;
  event_id: string | null;
  event_name: string | null;
  scanner_id: string | null;
  scanner_name: string | null;
  staff_id: string | null;
  staff_name: string | null;
  approver_name: string | null;
  method: ScanLogRow['method'];
  amount: number | null;
  before_value: string | null;
  after_value: string | null;
  pass_version: number | null;
  override_of: string | null;
  offline: number;
  actor_type: ScanLogRow['actorType'];
  actor_id: string;
  undone_at: number | null;
  undone_by_name: string | null;
  undone_by: string | null;
  undoes: string | null;
}
