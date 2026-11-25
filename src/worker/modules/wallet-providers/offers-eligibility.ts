import type { EffectiveChannels, OfferHold } from '../../../shared/contracts/channels.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { channelOn } from '../channels/gate.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { getPassLifecycle } from '../passes/repo-remove.ts';
import { canPresent } from '../public/presentation.ts';
import { passJsonAtVersion } from '../public/repo.ts';
import { readWalletPassSnapshot } from './instance.ts';
import { type NativeProvider, projectionPolicy } from './projection-contract.ts';
import { offersPaused } from './projection-pause.ts';
import { type ApprovedProjection, getApprovedProjection } from './projection-service.ts';
import { walletProviderEnabled } from './provider-policy.ts';
import { canRenderProjection } from './render-projection.ts';
import { accountCheckFailing } from './repo-account-health.ts';
import { walletOfferSnapshotCurrent } from './repo-offers.ts';
import { getProjectionCandidate } from './repo-projection-store.ts';
import {
  assertWalletRuntimeAccount,
  WalletRuntimeError,
  type WalletRuntimeScope,
} from './runtime.ts';
import { compileSamsungCard } from './samsung-compiled.ts';
import { samsungCardFresh } from './samsung-verification.ts';

let runtimeAccountCheck = assertWalletRuntimeAccount;

/** Tests only: replaces the runtime account check (Google's and Samsung's issuance currency). */
export function setRuntimeAccountCheckForTest(
  replacement: typeof assertWalletRuntimeAccount,
): () => void {
  const previous = runtimeAccountCheck;
  runtimeAccountCheck = replacement;
  return () => {
    runtimeAccountCheck = previous;
  };
}

/** Why a provider offer is withheld while its channel is on, after a channel-off retirement. */
export type WalletOfferHold = OfferHold;

/** Re-enabling creates a successor instance at epoch + 1; 16 is the schema's last epoch. */
export const MAX_CHANNEL_EPOCH = 16;

export interface OfferPassSnapshot {
  pass: Pass;
  lifecycleGeneration: number;
  credentialGeneration: number;
  rawPassJson: string;
  passJson: Record<string, unknown>;
}
export interface EligibleWalletProvider {
  snapshot: OfferPassSnapshot;
  approved: ApprovedProjection;
  runtimeScope: WalletRuntimeScope;
}

/** Keep the complete KEK binding set fixed across asynchronous offer operations. */
export function captureOfferContext(ctx: ServiceContext): ServiceContext {
  return { ...ctx, env: Object.freeze({ ...ctx.env }) };
}

/** Missing, invalid, stale, or inactive materialization is never projected. */
export async function offerPassSnapshot(
  ctx: ServiceContext,
  passOrId: Pass | string,
): Promise<OfferPassSnapshot | null> {
  ctx = captureOfferContext(ctx);
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const pass = typeof passOrId === 'string' ? await getPass(ctx.env.DB, passOrId) : passOrId;
  if (
    !pass?.releaseId ||
    pass.status !== 'active' ||
    pass.removedAt !== null ||
    pass.deletedAt !== null ||
    pass.testDataQuarantined
  )
    return null;
  const [lifecycle, rawPassJson, walletPass] = await Promise.all([
    getPassLifecycle(ctx.env.DB, pass),
    passJsonAtVersion(ctx.env.DB, pass.id, pass.version),
    readWalletPassSnapshot(ctx.env.DB, {
      orgId: pass.orgId,
      mode: pass.mode,
      passId: pass.id,
    }),
  ]);
  if (
    !lifecycle ||
    lifecycle.removal !== null ||
    !rawPassJson ||
    !walletPass ||
    walletPass.transferPending !== 0 ||
    walletPass.status !== 'active' ||
    walletPass.removedAt !== null ||
    walletPass.deletedAt !== null ||
    walletPass.quarantined !== 0 ||
    walletPass.templateId !== pass.templateId ||
    walletPass.templateVersion !== pass.templateVersion ||
    walletPass.passVersion !== pass.version ||
    walletPass.passRevision !== pass.revision ||
    walletPass.credentialGeneration !== pass.credentialGeneration ||
    walletPass.lifecycleGeneration !== lifecycle.generation ||
    walletPass.issuingReleaseId !== pass.releaseId
  )
    return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawPassJson);
  } catch {
    return null;
  }
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded) ||
    !canPresent(pass, decoded as Record<string, unknown>, ctx.clock.now())
  )
    return null;
  return {
    pass,
    lifecycleGeneration: lifecycle.generation,
    credentialGeneration: walletPass.credentialGeneration,
    rawPassJson,
    passJson: decoded as Record<string, unknown>,
  };
}

export async function offerStillCurrent(
  ctx: ServiceContext,
  eligible: EligibleWalletProvider,
  offer?: {
    ref: string;
    instanceId: string;
    version: number;
    consumed: boolean;
    deliver?: boolean;
  },
): Promise<boolean> {
  ctx = captureOfferContext(ctx);
  const { snapshot, approved, runtimeScope } = eligible;
  const pass = snapshot.pass;
  if (!pass.releaseId || !canPresent(pass, snapshot.passJson, ctx.clock.now())) return false;
  const current = await getApprovedProjection(ctx, {
    orgId: pass.orgId,
    mode: pass.mode,
    provider: approved.projection.provider,
    templateId: pass.templateId,
    templateVersion: pass.templateVersion,
    appleReleaseId: pass.releaseId,
  });
  if (
    !current ||
    current.release.id !== approved.release.id ||
    current.release.candidateHash !== approved.release.candidateHash ||
    current.release.accountId !== runtimeScope.accountId ||
    current.release.accountRevision !== runtimeScope.accountRevision ||
    current.release.providerIdentityHash !== runtimeScope.providerIdentityHash
  )
    return false;
  if (await offersPaused(ctx, current)) return false;
  try {
    await runtimeAccountCheck(ctx, runtimeScope, approved.projection.provider);
  } catch (error) {
    if (error instanceof WalletRuntimeError && error.code === 'account_unavailable') return false;
    throw error;
  }
  const refHash = offer ? await sha256Hex(offer.ref) : undefined;
  const now = ctx.clock.now();
  if (!canPresent(pass, snapshot.passJson, now)) return false;
  return walletOfferSnapshotCurrent(
    ctx.env.DB,
    pass,
    snapshot.lifecycleGeneration,
    snapshot.credentialGeneration,
    snapshot.rawPassJson,
    approved.projection.provider,
    approved.release.id,
    now,
    offer && refHash
      ? {
          refHash,
          instanceId: offer.instanceId,
          version: offer.version,
          now,
          consumed: offer.consumed,
          deliver: offer.deliver,
        }
      : undefined,
  );
}

/** Neither availability nor projection validation creates provider credentials or offers. */
export async function eligibleWalletProvider(
  ctx: ServiceContext,
  snapshot: OfferPassSnapshot,
  provider: NativeProvider,
  /** The caller's channel reading, when it has one: the gate is then not loaded again. */
  channels?: EffectiveChannels,
): Promise<EligibleWalletProvider | null> {
  ctx = captureOfferContext(ctx);
  const pass = snapshot.pass;
  if (!walletProviderEnabled(provider, pass.mode)) return null;
  if (!pass.releaseId) return null;
  // The one channel gate: platform, org, template and pass levels, and the design's capability.
  if (!(channels ? channels[provider].on : await channelOn(ctx, pass, provider))) return null;
  const policy = projectionPolicy(provider);
  const approved = await getApprovedProjection(ctx, {
    orgId: pass.orgId,
    mode: pass.mode,
    provider,
    templateId: pass.templateId,
    templateVersion: pass.templateVersion,
    appleReleaseId: pass.releaseId,
    adapterRevision: policy.adapterRevision,
    audiencePolicyRevision: policy.audiencePolicyRevision,
  });
  if (!approved || approved.projection.provider !== provider) return null;
  const runtimeScope: WalletRuntimeScope = {
    orgId: pass.orgId,
    mode: pass.mode,
    accountId: approved.release.accountId,
    accountRevision: approved.release.accountRevision,
    providerReleaseId: approved.release.id,
    providerIdentityHash: approved.release.providerIdentityHash,
  };
  // Q6: an account whose credential last failed its check shows no badge, until a check passes again.
  if (await accountCheckFailing(ctx.env.DB, approved.release.accountId)) return null;
  if (!canRenderProjection(approved.projection, snapshot.passJson)) return null;
  if (approved.projection.schema === 2 && provider === 'samsung') {
    // Compiled cards: the pass must compile to the approved type and the stored card read must be
    // fresh. A request path never calls Samsung; the sync job keeps the row current.
    const candidate = await getProjectionCandidate(ctx.env.DB, approved.release.candidateId ?? '');
    if (!candidate || !(await samsungCardFresh(ctx, candidate))) return null;
    try {
      if (
        !(await compileSamsungCard(ctx, {
          projection: approved.projection,
          pass,
          passJson: snapshot.passJson,
          refId: '0'.repeat(32),
          createdAt: ctx.clock.now(),
          revisedAt: pass.modifiedAt,
          art: 'dry',
          candidateId: candidate.id,
        }))
      )
        return null;
    } catch (error) {
      // A pass that cannot be compiled is not offered; the page still renders.
      ctx.log.warn('wallet.samsung_compile_failed', {
        code: 'WALLET_SAMSUNG_COMPILE_FAILED',
        orgId: pass.orgId,
        error,
      });
      return null;
    }
  }
  const result = { snapshot, approved, runtimeScope };
  return (await offerStillCurrent(ctx, result)) ? result : null;
}
