import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import type { Pass } from '../passes/repo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { getPassLifecycle } from '../passes/repo-remove.ts';
import { canPresent } from '../public/presentation.ts';
import { passJsonAtVersion } from '../public/repo.ts';
import { readWalletPassSnapshot } from './instance.ts';
import { type NativeProvider, projectionPolicy } from './projection-contract.ts';
import { type ApprovedProjection, getApprovedProjection } from './projection-service.ts';
import { walletProviderEnabled } from './provider-policy.ts';
import { canRenderSamsungProjection, renderGoogleProjection } from './render-projection.ts';
import { walletOfferSnapshotCurrent } from './repo-offers.ts';
import {
  assertWalletRuntimeAccount,
  WalletRuntimeError,
  type WalletRuntimeScope,
} from './runtime.ts';

export interface OfferPassSnapshot {
  pass: Pass;
  lifecycleGeneration: number;
  credentialGeneration: number;
  credentialKeysetCommitment: string;
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
  credentialKeysetCommitment: string,
): Promise<OfferPassSnapshot | null> {
  ctx = captureOfferContext(ctx);
  if (
    typeof credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(credentialKeysetCommitment) ||
    (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== credentialKeysetCommitment
  )
    return null;
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
      credentialKeysetCommitment,
    }),
  ]);
  if (
    !lifecycle ||
    lifecycle.removal !== null ||
    !rawPassJson ||
    !walletPass ||
    walletPass.credentialKeysetCommitment !== credentialKeysetCommitment ||
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
    credentialKeysetCommitment,
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
  if (runtimeScope.credentialKeysetCommitment !== snapshot.credentialKeysetCommitment) return false;
  const current = await getApprovedProjection(
    ctx,
    {
      orgId: pass.orgId,
      mode: pass.mode,
      provider: approved.projection.provider,
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      appleReleaseId: pass.releaseId,
    },
    { credentialKeysetCommitment: snapshot.credentialKeysetCommitment },
  );
  if (
    !current ||
    current.release.id !== approved.release.id ||
    current.release.candidateHash !== approved.release.candidateHash ||
    current.release.accountId !== runtimeScope.accountId ||
    current.release.accountRevision !== runtimeScope.accountRevision ||
    current.release.providerIdentityHash !== runtimeScope.providerIdentityHash
  )
    return false;
  try {
    await assertWalletRuntimeAccount(ctx, runtimeScope, approved.projection.provider);
  } catch (error) {
    if (error instanceof WalletRuntimeError && error.code === 'account_unavailable') return false;
    throw error;
  }
  // Opening account material may race a keyset change; keep the original proof.
  if (
    (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== snapshot.credentialKeysetCommitment
  )
    return false;
  const refHash = offer ? await sha256Hex(offer.ref) : undefined;
  const now = ctx.clock.now();
  if (!canPresent(pass, snapshot.passJson, now)) return false;
  return walletOfferSnapshotCurrent(
    ctx.env.DB,
    pass,
    snapshot.lifecycleGeneration,
    snapshot.credentialGeneration,
    snapshot.credentialKeysetCommitment,
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
): Promise<EligibleWalletProvider | null> {
  ctx = captureOfferContext(ctx);
  if (!walletProviderEnabled(provider)) return null;
  const pass = snapshot.pass;
  if (!pass.releaseId) return null;
  const policy = projectionPolicy(provider);
  const approved = await getApprovedProjection(
    ctx,
    {
      orgId: pass.orgId,
      mode: pass.mode,
      provider,
      templateId: pass.templateId,
      templateVersion: pass.templateVersion,
      appleReleaseId: pass.releaseId,
      adapterRevision: policy.adapterRevision,
      audiencePolicyRevision: policy.audiencePolicyRevision,
    },
    { credentialKeysetCommitment: snapshot.credentialKeysetCommitment },
  );
  if (!approved || approved.projection.provider !== provider) return null;
  const runtimeScope: WalletRuntimeScope = {
    orgId: pass.orgId,
    mode: pass.mode,
    accountId: approved.release.accountId,
    accountRevision: approved.release.accountRevision,
    providerReleaseId: approved.release.id,
    providerIdentityHash: approved.release.providerIdentityHash,
    credentialKeysetCommitment: snapshot.credentialKeysetCommitment,
  };
  const renderable =
    approved.projection.provider === 'google'
      ? renderGoogleProjection(approved.projection, snapshot.passJson) !== null
      : canRenderSamsungProjection(approved.projection, snapshot.passJson);
  if (!renderable) return null;
  const result = { snapshot, approved, runtimeScope };
  return (await offerStillCurrent(ctx, result)) ? result : null;
}
