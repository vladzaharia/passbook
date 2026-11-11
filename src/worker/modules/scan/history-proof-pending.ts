import type { ScanDisplayNeeds } from '../../../passkit/template/scan-display/index.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { credentialKeysetContext } from './credential-keyset-authority.ts';
import { captureDisplayHistoryScope, sameDisplayHistoryScope } from './history-display-scope.ts';
import { type VerifiedHistoryProof, verifyHistoryProofRow } from './history-proof.ts';
import { validCredentialKeysetCommitment } from './repo-credential-tombstones.ts';
import { type HistoryProofRow, historyProofRowsStmt } from './repo-history-proof-read.ts';
import type { Finalize } from './repo-scans.ts';
import type { Found } from './resolve.ts';
import { releaseClass as recordedReleaseClass } from './scan-event-proof-envelope.ts';
import {
  InvalidScanRetentionProof,
  type PreparedScanRetentionProof,
  prepareScanRetentionProof,
  verifyScanRetentionProof,
} from './scan-retention-proof.ts';

type ProofBatchResult =
  | { success: true; results: unknown[] }
  | { success: false; results?: unknown[] };

const brand: unique symbol = Symbol('pending-display-history-source');
export interface PendingDisplayHistorySource {
  readonly [brand]: true;
}
interface PendingState {
  operation: ServiceContext;
  row: HistoryProofRow;
  capturedWithoutEvent: readonly unknown[];
  scanId: string;
  keyset: string;
}
const pendingSources = new WeakMap<PendingDisplayHistorySource, PendingState>();

/** Capture the pending claim and its exact pass, Wallet and policy sources in an existing D1 batch. */
export function planPendingDisplayHistorySource(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  scanId: string,
  needs: ScanDisplayNeeds,
): {
  stmts: D1PreparedStatement[];
  finish(results: readonly ProofBatchResult[]): PendingDisplayHistorySource | null;
} {
  const operation = credentialKeysetContext(ctx);
  const requested = needs.history.length > 0 || needs.ledger.length > 0;
  const capturedWithoutEvent = captureDisplayHistoryScope({ ...actor, event: null }, found);
  const keyset = found.credentialKeysetCommitment;
  const walletVersion = found.walletVersion;
  const valid =
    validCredentialKeysetCommitment(keyset) &&
    actor.credentialKeysetCommitment === keyset &&
    typeof walletVersion === 'number' &&
    Number.isSafeInteger(walletVersion) &&
    walletVersion > 0;
  const stmts =
    requested && valid
      ? [
          historyProofRowsStmt(
            operation,
            {
              pending: { scanId, passId: found.pass.id, walletVersion },
            },
            `s.actor_key=?/* scan-ephemeral-actor-key */ AND s.org_id=? AND s.mode=?
    AND p.org_id=? AND p.mode=? AND p.template_id=?/* scan-ephemeral-template-id */`,
            [
              actor.actorKey,
              actor.orgId,
              actor.mode,
              actor.orgId,
              actor.mode,
              found.pass.templateId,
            ],
            keyset,
          ),
        ]
      : [];
  let consumed = false;
  return {
    stmts,
    finish(results) {
      if (
        consumed ||
        !requested ||
        !valid ||
        results.length !== 1 ||
        !results[0]?.results ||
        results[0].results.length !== 1 ||
        results[0].success === false ||
        !sameDisplayHistoryScope(
          capturedWithoutEvent,
          captureDisplayHistoryScope({ ...actor, event: null }, found),
        )
      )
        return null;
      consumed = true;
      const row = results[0].results[0] as unknown as HistoryProofRow;
      if (
        row.id !== scanId ||
        row.org_id !== actor.orgId ||
        row.mode !== actor.mode ||
        row.actor_key !== actor.actorKey ||
        row.state !== 'pending' ||
        row.projection_current !== 1 ||
        row.current_transfer_pending !== 0 ||
        row.current_pass_version !== found.pass.version ||
        row.current_pass_revision !== found.pass.revision ||
        row.current_credential_generation !== found.pass.credentialGeneration ||
        row.current_lifecycle_generation !== found.pass.lifecycleGeneration ||
        row.current_image_generation !== found.pass.imageGeneration ||
        row.current_pinned_version !== found.pass.templateVersion ||
        row.current_active_version !== found.activeVersion ||
        row.recorded_wallet_version !== walletVersion ||
        row.current_wallet_version !== walletVersion ||
        row.recorded_wallet_template_version !== found.walletTemplateVersion ||
        row.current_identity_id !== found.pass.identityId ||
        row.current_link_generation !== found.pass.linkGeneration ||
        row.current_connection_id !== found.pass.connectionId ||
        row.current_connection_generation !== found.connectionGeneration ||
        row.current_org_revision !== found.orgRevision ||
        row.current_template_revision !== found.templateRevision ||
        row.current_identity_revision !== found.identityRevision ||
        row.current_release_id !== found.activeReleaseId ||
        row.current_release_generation !== found.activeReleaseGeneration ||
        row.current_release_hash !== found.activeReleaseCandidateHash ||
        row.undone_by !== null ||
        row.amount !== null ||
        row.before_value !== null ||
        row.after_value !== null
      )
        return null;
      const token = Object.freeze({ [brand]: true as const });
      pendingSources.set(token, { operation, row, capturedWithoutEvent, scanId, keyset });
      return token;
    },
  };
}

/** Verify the signed planned scan before creating its exact post-finalization proof fence. */
export async function preparePlannedDisplayHistoryProof(
  source: PendingDisplayHistorySource,
  actor: ScanActor,
  found: Found,
  retained: PreparedScanRetentionProof,
  finalized: Finalize,
): Promise<VerifiedHistoryProof | null> {
  const state = pendingSources.get(source);
  if (
    !state ||
    !sameDisplayHistoryScope(
      state.capturedWithoutEvent,
      captureDisplayHistoryScope({ ...actor, event: null }, found),
    )
  )
    return null;
  pendingSources.delete(source);
  const event = { ...retained.event };
  const scan = { ...retained.scan };
  const proof = { ...retained.proof };
  const final = { ...finalized };
  const { row, keyset } = state;
  if (
    actor.credentialKeysetCommitment !== keyset ||
    found.credentialKeysetCommitment !== keyset ||
    final.id !== state.scanId ||
    scan.id !== state.scanId ||
    final.claimAt !== row.at ||
    scan.at !== row.at ||
    event.org_id !== actor.orgId ||
    event.mode !== actor.mode ||
    event.pass_id !== found.pass.id ||
    event.actor_type !== actor.actor.type ||
    event.actor_id !== actor.actor.id ||
    scan.orgId !== actor.orgId ||
    scan.mode !== actor.mode ||
    scan.actorKey !== row.actor_key ||
    scan.scannerId !== row.scanner_id ||
    scan.staffId !== row.staff_id ||
    scan.method !== row.method ||
    final.outcome !== 'ok' ||
    scan.outcome !== 'ok' ||
    final.reason !== scan.reason ||
    final.passId !== found.pass.id ||
    final.templateId !== found.pass.templateId ||
    scan.templateId !== final.templateId ||
    final.actionId !== scan.actionId ||
    final.actionKind !== scan.actionKind ||
    final.passVersion !== scan.passVersion ||
    final.approvedBy !== scan.approvedBy ||
    (final.direction ?? null) !== scan.direction ||
    (final.presenceScope ?? null) !== scan.presenceScope ||
    (final.eventId ?? row.event_id) !== scan.eventId ||
    proof.scanId !== scan.id ||
    proof.ledgerEventId !== event.id ||
    !(await verifyScanRetentionProof(state.operation.env, proof, scan))
  )
    return null;
  try {
    const rebuilt = await prepareScanRetentionProof(state.operation.env, event, scan.actorKey, {
      actionId: scan.actionId,
    });
    if (rebuilt.proof.mac !== proof.mac) return null;
  } catch (error) {
    if (error instanceof InvalidScanRetentionProof) return null;
    throw error;
  }
  if (
    !sameDisplayHistoryScope(
      state.capturedWithoutEvent,
      captureDisplayHistoryScope({ ...actor, event: null }, found),
    )
  )
    return null;
  let data: {
    authority?: {
      pinnedTemplateVersion?: unknown;
      activeTemplateVersion?: unknown;
      walletVersion?: unknown;
      walletTemplateVersion?: unknown;
    };
  };
  try {
    data = JSON.parse(event.data);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const authority = data.authority;
  const releaseClass = authority
    ? recordedReleaseClass(authority as Record<string, unknown>)
    : null;
  if (
    !authority ||
    authority.pinnedTemplateVersion !== row.recorded_template_version ||
    authority.activeTemplateVersion !== row.event_active_version ||
    authority.walletVersion !== row.recorded_wallet_version ||
    authority.walletTemplateVersion !== row.recorded_wallet_template_version ||
    (releaseClass !== 'approved' && releaseClass !== 'legacy')
  )
    return null;
  const projected: HistoryProofRow = {
    ...row,
    pass_id: final.passId,
    template_id: final.templateId,
    event_id: scan.eventId,
    state: 'done',
    outcome: final.outcome,
    reason: final.reason,
    action_id: final.actionId,
    action_kind: final.actionKind,
    override_of: final.overrideOf,
    approved_by: final.approvedBy,
    pass_version: final.passVersion,
    direction: final.direction ?? null,
    presence_scope: final.presenceScope ?? null,
    approved_proof: releaseClass === 'approved' ? 1 : 0,
    legacy_proof: releaseClass === 'legacy' ? 1 : 0,
    ledger_id: event.id,
    ledger_org_id: event.org_id,
    ledger_pass_id: event.pass_id,
    ledger_mode: event.mode,
    ledger_kind: event.kind,
    ledger_device: event.device,
    ledger_actor_type: event.actor_type,
    ledger_actor_id: event.actor_id,
    ledger_data: event.data,
    ledger_at: event.at,
  };
  const verified = await verifyHistoryProofRow(state.operation, projected, keyset);
  return verified &&
    sameDisplayHistoryScope(
      state.capturedWithoutEvent,
      captureDisplayHistoryScope({ ...actor, event: null }, found),
    )
    ? verified
    : null;
}
