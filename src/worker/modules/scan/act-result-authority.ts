import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { EventRow } from '../events/repo.ts';
import {
  captureCredentialKeyEnv,
  credentialRefKeysetCommitment,
} from '../passes/credential-keyset.ts';
import type { Pass } from '../passes/repo-map.ts';
import { StaleScanAuthority } from './act-override.ts';
import { eventSafeProjectionWithCommitments } from './event-safe-projection.ts';
import { type StopAuthority, stopAuthorityPredicate } from './repo-action-authority.ts';
import { scanCandidateTemplateReadPredicate } from './repo-live-template-snapshot.ts';
import type { Candidate } from './repo-lookup.ts';
import { outputAuthorityPredicate } from './repo-output-authority.ts';
import { andOutputPredicates, type OutputPredicate } from './repo-output-predicates.ts';
import {
  type ScanEffectSnapshot,
  type ScanGateEventProjection,
  signedEffectSnapshot,
} from './repo-scan-effect.ts';
import type { Found } from './resolve.ts';
import { scanActionIdRef } from './scan-action-ref.ts';
import { sealScanEvent } from './scan-event-proof.ts';

/** The caller must guard its write with stopAuthorityPredicate in this same transaction. */
export function outputAuthorityFence(
  ctx: ServiceContext,
  authority: StopAuthority,
  pass: Pass | null,
  found: Found | null,
  extra?: { sql: string; params: readonly SqlValue[] },
  source?: Candidate,
  allowInactive = false,
  requirePhoto = false,
  at?: number,
): OutputPredicate {
  const now = at ?? ctx.clock.now();
  const candidate = found?.liveCandidate ?? source;
  if ((pass || found) && !authority.passFence) return { sql: '0', params: [] };
  if (pass || found || candidate) {
    if (
      !candidate ||
      !Array.isArray(candidate.credentialTombstoneRefs) ||
      (pass && candidate.pass.id !== pass.id)
    )
      return { sql: '0', params: [] };
    const template = scanCandidateTemplateReadPredicate(candidate);
    const output = outputAuthorityPredicate({
      actor: authority.actor,
      event: authority.event,
      now,
      adminEventTemplates: authority.adminEventTemplates,
      templateId: authority.templateId,
      pass: candidate.pass,
      connectionGeneration: candidate.connectionGeneration,
      credentialKeysetCommitment: candidate.credentialKeysetCommitment,
      credentialTombstoneRefs: candidate.credentialTombstoneRefs,
      activeTemplateVersion: candidate.activeTemplateVersion,
      orgRevision: candidate.orgRevision,
      templateRevision: candidate.templateRevision,
      release: candidate,
      purpose: 'commit',
      displayTemplateVersion: candidate.displayTemplateVersion,
      checkInRules: candidate.checkInRules,
      lookupHash: candidate.lookupHash,
      requirePhoto,
      requireActive: !!found,
      allowInactive,
      expectedWalletStatus: authority.passFence?.walletStatus,
      extra: template,
    });
    return extra ? andOutputPredicates([output, extra]) : output;
  }
  const fence = stopAuthorityPredicate(authority, pass, now, true);
  return extra ? andOutputPredicates([fence, extra]) : fence;
}

export interface LedgerAuthorityOptions {
  claimAt: number;
  credentialKeysetCommitment: string;
  direction: 'in' | 'out' | null;
  presenceScope: string | null;
  found: Found | null;
  action: ResolvedScanAction | null;
  gate?: ScanGateEventProjection;
  effect?: ScanEffectSnapshot;
  gateScope?: string;
}

/** Record the plain event-time facts (no proof material) so an earlier scan cannot authorize a later mutation. */
export async function ledgerAuthoritySnapshot(
  ctx: ServiceContext,
  row: EventRow,
  pass: Pass,
  authority: StopAuthority,
  options: LedgerAuthorityOptions,
): Promise<EventRow> {
  const keys = captureCredentialKeyEnv(ctx.env);
  const originalCommitment = options.credentialKeysetCommitment;
  if (
    !authority.passFence ||
    pass.testDataQuarantined ||
    !/^[0-9a-f]{64}$/.test(originalCommitment) ||
    originalCommitment !== authority.passFence.credentialKeysetCommitment ||
    pass.credentialGeneration !== authority.passFence.credentialGeneration ||
    pass.lifecycleGeneration !== authority.passFence.lifecycleGeneration ||
    authority.passFence.noPendingTransfer !== true
  )
    throw new StaleScanAuthority();
  const { claimAt, direction, presenceScope, gate, effect, gateScope } = options;
  const actor = authority.actor;
  const data = JSON.parse(row.data) as { scanId: string };
  const [eventProjection, actionIdRef, keyset] = await Promise.all([
    eventSafeProjectionWithCommitments(keys, options.found, actor, options.action, data.scanId),
    options.action
      ? scanActionIdRef(keys, {
          orgId: pass.orgId,
          mode: pass.mode,
          templateId: pass.templateId,
          actionId: options.action.id,
        })
      : Promise.resolve(null),
    credentialRefKeysetCommitment(keys),
  ]);
  if (keyset !== originalCommitment) throw new StaleScanAuthority();
  if (
    (effect?.gateBefore && effect.gateBefore.actionId !== options.action?.id) ||
    (effect?.gateAfter && effect.gateAfter.actionId !== options.action?.id)
  )
    throw new StaleScanAuthority();
  const signedEffect = signedEffectSnapshot(
    effect ?? { gateBefore: null, gateAfter: null, presenceBefore: null, presenceAfter: null },
    actionIdRef,
  );
  const captured = {
    ...row,
    data: JSON.stringify({
      ...data,
      actionIdRef,
      authority: {
        linkGeneration: pass.linkGeneration,
        credentialGeneration: pass.credentialGeneration,
        lifecycleGeneration: pass.lifecycleGeneration,
        noPendingTransfer: true,
        pinnedReleaseId: pass.releaseId ?? null,
        templateId: pass.templateId,
        pinnedTemplateVersion: pass.templateVersion,
        scanAt: claimAt,
        presenceScope,
        nonQuarantined: !pass.testDataQuarantined,
        passJsonHash: authority.passFence?.passJsonHash ?? null,
        walletVersion: authority.passFence?.walletVersion ?? null,
        walletTemplateVersion: authority.passFence?.walletTemplateVersion ?? null,
        personalizationHash: authority.passFence?.personalizationHash ?? null,
        evaluatedPersonalizationHash: authority.passFence?.evaluatedPersonalizationHash ?? null,
        identityId: pass.identityId,
        identityPassTypeIdentifier: authority.passFence?.identityPassTypeIdentifier ?? null,
        identityTeamIdentifier: authority.passFence?.identityTeamIdentifier ?? null,
        identityRevision: authority.passFence?.identityRevision ?? null,
        connectionGeneration: authority.passFence?.connectionGeneration ?? null,
        activeTemplateVersion: authority.passFence?.activeTemplateVersion ?? null,
        activeReleaseId: authority.passFence?.activeReleaseId ?? null,
        activeReleaseGeneration: authority.passFence?.activeReleaseGeneration ?? null,
        activeReleaseVersion: authority.passFence?.activeReleaseVersion ?? null,
        activeReleaseCandidateHash: authority.passFence?.activeReleaseCandidateHash ?? null,
        orgRevision: authority.passFence?.orgRevision ?? null,
        templateRevision: authority.passFence?.templateRevision ?? null,
        scannerRevision: actor.scanner?.updatedAt ?? null,
        sessionId: actor.scanningSession?.id ?? null,
        sessionRevision: actor.scanningSession?.updatedAt ?? null,
        eventId: (authority.event ?? actor.event)?.id ?? null,
        eventRevision: (authority.event ?? actor.event)?.updatedAt ?? null,
        staffId: actor.staff?.id ?? null,
        staffRevision: actor.staff?.updatedAt ?? null,
        role: actor.role,
        eventProjection,
        effect: signedEffect,
        ...(gate ? { gate } : {}),
      },
    }),
  };
  return sealScanEvent(
    keys,
    captured,
    gate?.scope ?? gateScope ?? null,
    claimAt,
    direction,
    presenceScope,
  );
}
