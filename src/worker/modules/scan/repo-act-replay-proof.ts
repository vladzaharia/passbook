import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { EventRow } from '../events/repo.ts';
import { StaleScanAuthority } from './act-override.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ReplayEvidence } from './repo-act-authority.ts';
import { candidatesOf } from './repo-lookup.ts';
import type { ScanRow } from './repo-scan-map.ts';
import { type ScanEventReference, verifyScanEventProvenance } from './scan-event-proof.ts';
import { releaseClass as recordedReleaseClass } from './scan-event-proof-envelope.ts';
import type { PasslessScan } from './scan-passless.ts';
import {
  type ScanRetentionProofRow,
  type ScanRetentionSnapshot,
  verifyScanRetentionProof,
} from './scan-retention-proof.ts';

type ReceiptEvidence = EventRow & {
  approved_proof: number;
  pinned_template_version: string | null;
  wallet_version: number | null;
  wallet_template_version: string | null;
};
type RetentionRaw = Omit<ScanRetentionSnapshot, 'override'> & {
  proofScanId: string;
  proofOrgId: string;
  proofMode: Mode;
  ledgerEventId: string;
  passRef: string;
  eventDigest: string;
  scanDigest: string;
  gateSnapshot: string | null;
  presenceSnapshot: string | null;
  mac: string;
  excluded: number;
  invalidated: number;
  override: number;
};

export async function resolveReplayEvidence(
  ctx: ServiceContext,
  row: ScanRow,
  credentials: CredentialTombstoneSnapshot,
  results: D1Result[],
  proofIndex: number,
  candidateIndex: number,
  base: ReplayEvidence,
): Promise<ReplayEvidence> {
  if (row.passId) {
    const evidence = results[proofIndex]?.results?.[0] as ReceiptEvidence | undefined;
    if (!evidence?.pinned_template_version || evidence.wallet_version === null)
      throw new StaleScanAuthority();
    const ledger: EventRow = {
      id: evidence.id,
      org_id: evidence.org_id,
      pass_id: evidence.pass_id,
      mode: evidence.mode,
      kind: evidence.kind,
      device: evidence.device,
      actor_type: evidence.actor_type,
      actor_id: evidence.actor_id,
      data: evidence.data,
      at: evidence.at,
    };
    const reference: ScanEventReference = {
      ...row,
      pinnedTemplateVersion: evidence.pinned_template_version,
      walletVersion: evidence.wallet_version,
      walletTemplateVersion: evidence.wallet_template_version,
      direction: row.direction ?? null,
      presenceScope: row.presenceScope ?? null,
    };
    if (!(await verifyScanEventProvenance(ctx.env, ledger, reference)))
      throw new StaleScanAuthority();
    const data: unknown = JSON.parse(evidence.data);
    if (
      !data ||
      typeof data !== 'object' ||
      !('authority' in data) ||
      !data.authority ||
      typeof data.authority !== 'object' ||
      Array.isArray(data.authority)
    )
      throw new StaleScanAuthority();
    const recorded = data.authority as Record<string, unknown>;
    const releaseClass = recordedReleaseClass(recorded);
    if (
      (releaseClass === 'approved' && evidence.approved_proof !== 1) ||
      (releaseClass !== 'approved' && releaseClass !== 'legacy')
    )
      throw new StaleScanAuthority();
    const selected = candidatesOf(results[candidateIndex])[0] ?? null;
    if (selected && selected.credentialKeysetCommitment !== credentials.credentialKeysetCommitment)
      throw new StaleScanAuthority();
    if (selected && selected.transferPending !== false) throw new StaleScanAuthority();
    return {
      ...base,
      ledger,
      reference,
      recorded,
      approved: releaseClass === 'approved',
      candidate: selected ? { ...selected, ...credentials } : null,
    };
  }
  if (row.templateId === null) {
    const raw = results[proofIndex]?.results?.[0] as PasslessScan | undefined;
    if (!raw) throw new StaleScanAuthority();
    const proof: PasslessScan = {
      scanId: raw.scanId,
      orgId: raw.orgId,
      mode: raw.mode,
      at: raw.at,
    };
    return { ...base, passless: proof };
  }
  const raw = results[proofIndex]?.results?.[0] as RetentionRaw | undefined;
  if (raw?.excluded !== 0 || raw.invalidated !== 0) throw new StaleScanAuthority();
  const proof: ScanRetentionProofRow = {
    scanId: raw.proofScanId,
    orgId: raw.proofOrgId,
    mode: raw.proofMode,
    ledgerEventId: raw.ledgerEventId,
    passRef: raw.passRef,
    eventDigest: raw.eventDigest,
    scanDigest: raw.scanDigest,
    gateSnapshot: raw.gateSnapshot,
    presenceSnapshot: raw.presenceSnapshot,
    mac: raw.mac,
    excluded: 0,
    invalidated: 0,
  };
  const scan = {
    id: raw.id,
    orgId: raw.orgId,
    mode: raw.mode,
    templateId: raw.templateId,
    scannerId: raw.scannerId,
    eventId: raw.eventId,
    actorType: raw.actorType,
    actorId: raw.actorId,
    actorKey: raw.actorKey,
    staffId: raw.staffId,
    approvedBy: raw.approvedBy,
    method: raw.method,
    state: raw.state,
    outcome: raw.outcome,
    reason: raw.reason,
    actionId: raw.actionId,
    actionKind: raw.actionKind,
    direction: raw.direction,
    passVersion: raw.passVersion,
    presenceScope: raw.presenceScope,
    at: raw.at,
    undoes: raw.undoes,
    override: raw.override === 1,
  };
  if (!(await verifyScanRetentionProof(ctx.env, proof, scan))) throw new StaleScanAuthority();
  return { ...base, retention: { proof, scan } };
}
