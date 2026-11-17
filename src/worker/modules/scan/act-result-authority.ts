import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { EventRow } from '../events/repo.ts';
import {
  captureCredentialKeyEnv,
  credentialRefKeysetCommitment,
} from '../passes/credential-keyset.ts';
import type { Pass } from '../passes/repo-map.ts';
import { StaleScanAuthority } from './act-override.ts';
import { eventSafeProjectionWithCommitments } from './event-safe-projection.ts';
import {
  type ScanEffectSnapshot,
  type ScanGateEventProjection,
  signedEffectSnapshot,
} from './repo-scan-effect.ts';
import type { Found } from './resolve.ts';
import { scanActionIdRef } from './scan-action-ref.ts';
import { sealScanEvent } from './scan-event-proof.ts';
import type { StopAuthority } from './scan-stop-authority.ts';

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

/**
 * Record the event-time facts so an earlier scan cannot authorize a later mutation: plain
 * generations and revisions, plus unsigned content digests (passJsonHash, personalizationHash,
 * evaluatedPersonalizationHash, activeReleaseCandidateHash) and the keyed actionIdRef. The digests
 * are stored because act-replay and the proof envelope compare them to the pass's current
 * fence; no signature or proof secret is stored.
 */
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
