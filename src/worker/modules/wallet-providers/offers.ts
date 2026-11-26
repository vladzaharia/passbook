import type { EffectiveChannels } from '../../../shared/contracts/channels.ts';
import { revealToken } from '../../platform/capability-token.ts';
import { classifyD1Error } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordCopy } from '../channels/gate.ts';
import { assertNotPreviewOnly } from '../developer/fence.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { passForToken } from '../public/service.ts';
import { ensureSamsungFetchRef } from './callbacks-ref.ts';
import {
  consumeWalletOfferRef,
  createWalletInstanceAndOffer,
  expireWalletOfferRef,
  getWalletInstance,
  type WalletInstanceProof,
} from './instance.ts';
import {
  captureOfferContext,
  type EligibleWalletProvider,
  eligibleWalletProvider,
  offerPassSnapshot,
  offerStillCurrent,
} from './offers-eligibility.ts';
import { googleSaveLocation } from './offers-google.ts';
import {
  channelOffSuccessor,
  instanceCanActivate,
  instanceMatches,
  walletOfferNotFound as notFound,
} from './offers-instance.ts';
import { type NativeProvider, projectionPolicy } from './projection-contract.ts';
import { assertWalletProviderEnabled, walletProviderEnabled } from './provider-policy.ts';
import {
  createSamsungRuntimeOffer,
  WalletRuntimeError,
  type WalletRuntimeScope,
} from './runtime.ts';

export interface WalletOffer {
  provider: 'google' | 'samsung';
  href: string;
  installation: 'unknown';
}

/** Lists only capability links. Provider tokens are not created until a holder follows one. */
export async function listWalletOffers(
  ctx: ServiceContext,
  passId: string,
  channels?: EffectiveChannels,
): Promise<WalletOffer[]> {
  if (!walletProviderEnabled('google') && !walletProviderEnabled('samsung')) return [];
  ctx = captureOfferContext(ctx);
  const snapshot = await offerPassSnapshot(ctx, passId);
  if (!snapshot) return [];
  const { pass: offered } = snapshot;
  const plainToken = await revealToken(
    ctx.env,
    'pass',
    offered.id,
    offered.orgId,
    offered.downloadToken,
  );
  const candidates: { eligible: EligibleWalletProvider; offer: WalletOffer }[] = [];
  for (const provider of ['google', 'samsung'] as const) {
    const eligible = await eligibleWalletProvider(ctx, snapshot, provider, channels);
    if (!eligible) continue;
    const instance = await getWalletInstance(ctx.env.DB, {
      orgId: snapshot.pass.orgId,
      mode: snapshot.pass.mode,
      provider,
      passId: snapshot.pass.id,
    });
    if (!instanceCanActivate(instance, snapshot.credentialGeneration)) continue;
    const successor = instance && channelOffSuccessor(instance);
    if (successor) {
      if (successor.hold) continue;
    } else if (instance && !(await instanceMatches(ctx, eligible, instance, true))) continue;
    // Neither provider proves a particular holder's installation or removal.
    candidates.push({
      eligible,
      offer: {
        provider,
        href: `/p/${plainToken}/wallet/${provider}`,
        installation: 'unknown',
      },
    });
  }
  const result: WalletOffer[] = [];
  for (const candidate of candidates)
    if (await offerStillCurrent(ctx, candidate.eligible)) result.push(candidate.offer);
  return result;
}

/** Resolve the existing pass capability, then atomically issue an instance-bound short-lived offer. */
export async function issueWalletOffer(
  ctx: ServiceContext,
  token: string,
  provider: NativeProvider,
): Promise<string> {
  return (await issueWalletOfferScoped(ctx, token, provider)).location;
}

/** The offer and the account scope it was issued under, so a bundle can combine several of them. */
export async function issueWalletOfferScoped(
  ctx: ServiceContext,
  token: string,
  provider: NativeProvider,
): Promise<{ location: string; scope: WalletRuntimeScope }> {
  if (provider !== 'google' && provider !== 'samsung') throw notFound();
  assertWalletProviderEnabled(provider);
  ctx = captureOfferContext(ctx);
  const pass = await passForToken(ctx, token);
  await assertNotPreviewOnly(ctx.env.DB, pass.orgId);
  const snapshot = await offerPassSnapshot(ctx, pass);
  if (!snapshot) throw notFound();
  const eligible = await eligibleWalletProvider(ctx, snapshot, provider);
  if (!eligible) throw notFound();
  const existing = await getWalletInstance(ctx.env.DB, {
    orgId: pass.orgId,
    mode: pass.mode,
    provider,
    passId: pass.id,
  });
  if (!instanceCanActivate(existing, snapshot.credentialGeneration)) throw notFound();
  const successor = existing && channelOffSuccessor(existing);
  if (successor) {
    if (successor.hold) throw notFound();
  } else if (existing && !(await instanceMatches(ctx, eligible, existing, true))) throw notFound();
  const policy = projectionPolicy(provider);
  const proof: WalletInstanceProof = {
    orgId: pass.orgId,
    mode: pass.mode,
    provider,
    passId: pass.id,
    passVersion: pass.version,
    passRevision: pass.revision,
    lifecycleGeneration: snapshot.lifecycleGeneration,
    passCredentialGeneration: snapshot.credentialGeneration,
    issuingReleaseId: pass.releaseId,
    projectionReleaseId: eligible.approved.release.id,
    accountId: eligible.runtimeScope.accountId,
    accountRevision: eligible.runtimeScope.accountRevision,
    adapterRevision: policy.adapterRevision,
    policyRevision: policy.audiencePolicyRevision,
  };
  const created = await createWalletInstanceAndOffer(ctx.env.DB, {
    ...proof,
    instanceId: ctx.ids.id(),
    requestKey: ctx.ids.token(32),
    now: ctx.clock.now(),
    newId: () => ctx.ids.id(),
    // The stored value (the token's MAC): the bearer check compares it with the row at commit.
    authority: { kind: 'download', token: pass.downloadToken },
  }).catch((error: unknown) => {
    // A guard trigger or constraint that refuses the activation is "not available", never a 500.
    const refused = classifyD1Error(error, { triggers: true });
    if (!refused) throw error;
    ctx.log.warn('wallet.offer_refused', { code: 'WALLET_OFFER_REFUSED', detail: refused.detail });
    throw notFound();
  });
  if (!created) throw notFound();
  const { operation, ref, expiresAt } = created;
  let delivered = false;
  let fenceLost = false;
  try {
    const instance = await getWalletInstance(ctx.env.DB, {
      orgId: pass.orgId,
      mode: pass.mode,
      provider,
      passId: pass.id,
    });
    if (
      instance?.lifecycle !== 'active' ||
      instance.id !== operation.instanceId ||
      instance.identityProjectionReleaseId !== operation.identityProjectionReleaseId ||
      operation.credentialGeneration !== snapshot.credentialGeneration ||
      !(await instanceMatches(ctx, eligible, instance))
    )
      throw notFound();
    const fence = { ref, instanceId: instance.id, version: operation.version, consumed: false };
    const assertCurrent = async () => {
      if (ctx.clock.now() >= expiresAt || !(await offerStillCurrent(ctx, eligible, fence))) {
        fenceLost = true;
        throw notFound();
      }
    };
    let location: string;
    if (provider === 'google' && eligible.approved.projection.provider === 'google') {
      location = await googleSaveLocation(ctx, {
        pass,
        eligible,
        instance,
        operation,
        expiresAt,
        assertCurrent,
      });
    } else if (provider === 'samsung') {
      location = `/p/wallet/samsung/${ref}`;
    } else throw notFound();
    if (
      ctx.clock.now() >= expiresAt ||
      !(await offerStillCurrent(ctx, eligible, fence)) ||
      ctx.clock.now() >= expiresAt
    )
      throw notFound();
    delivered = true;
    await recordCopy(ctx, pass, provider);
    return { location, scope: eligible.runtimeScope };
  } catch (error) {
    if (fenceLost || (error instanceof WalletRuntimeError && error.code === 'account_unavailable'))
      throw notFound();
    throw error;
  } finally {
    if (!delivered) await expireWalletOfferRef(ctx.env.DB, ref, ctx.clock.now());
  }
}

/** A one-use local wrapper controls initial disclosure, not Samsung's later refresh link. */
export async function redeemSamsungOffer(ctx: ServiceContext, ref: string): Promise<string> {
  assertWalletProviderEnabled('samsung');
  if (!/^[A-Za-z0-9_-]{43}$/.test(ref)) throw notFound();
  ctx = captureOfferContext(ctx);
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const binding = await consumeWalletOfferRef(ctx.env.DB, ref, ctx.clock.now());
  if (binding?.provider !== 'samsung') throw notFound();
  await assertNotPreviewOnly(ctx.env.DB, binding.orgId);
  let delivered = false;
  let fenceLost = false;
  try {
    const snapshot = await offerPassSnapshot(ctx, binding.passId);
    if (
      !snapshot ||
      snapshot.pass.orgId !== binding.orgId ||
      snapshot.pass.mode !== binding.mode ||
      snapshot.credentialGeneration !== binding.credentialGeneration
    )
      throw notFound();
    const eligible = await eligibleWalletProvider(ctx, snapshot, 'samsung');
    if (eligible?.approved.projection.provider !== 'samsung') throw notFound();
    const instance = await getWalletInstance(ctx.env.DB, {
      orgId: binding.orgId,
      mode: binding.mode,
      provider: 'samsung',
      passId: binding.passId,
    });
    if (
      instance?.lifecycle !== 'active' ||
      instance.id !== binding.instanceId ||
      instance.credentialGeneration !== binding.credentialGeneration ||
      instance.identityProjectionReleaseId !== binding.identityProjectionReleaseId ||
      !(await instanceMatches(ctx, eligible, instance))
    )
      throw notFound();
    const refId = await ensureSamsungFetchRef(ctx, {
      orgId: binding.orgId,
      mode: binding.mode,
      instanceId: binding.instanceId,
      operationVersion: binding.version,
      expiresAt: binding.expiresAt,
    });
    if (!refId) throw notFound();
    const fence = { ref, instanceId: binding.instanceId, version: binding.version, consumed: true };
    const assertCurrent = async () => {
      if (
        ctx.clock.now() >= binding.expiresAt ||
        !(await offerStillCurrent(ctx, eligible, fence))
      ) {
        fenceLost = true;
        throw notFound();
      }
    };
    const location = await createSamsungRuntimeOffer(ctx, eligible.runtimeScope, {
      refId,
      assertCurrent,
    });
    if (
      !location.startsWith('https://a.swallet.link/atw/v3/') ||
      ctx.clock.now() >= binding.expiresAt ||
      !(await offerStillCurrent(ctx, eligible, { ...fence, deliver: true })) ||
      ctx.clock.now() >= binding.expiresAt
    )
      throw notFound();
    delivered = true;
    return location;
  } catch (error) {
    if (fenceLost || (error instanceof WalletRuntimeError && error.code === 'account_unavailable'))
      throw notFound();
    throw error;
  } finally {
    if (!delivered) await expireWalletOfferRef(ctx.env.DB, ref, ctx.clock.now());
  }
}
