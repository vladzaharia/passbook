import { baseUrl } from '../../platform/env.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { passForToken } from '../public/service.ts';
import { ensureSamsungFetchRef } from './callbacks-ref.ts';
import { registerGoogleCallbackBinding } from './google-callback-binding.ts';
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
import { instanceMatches } from './offers-instance.ts';
import { type NativeProvider, projectionPolicy } from './projection-contract.ts';
import { assertWalletProviderEnabled, walletProviderEnabled } from './provider-policy.ts';
import { walletOfferKeysetCurrent } from './repo-offers.ts';
import {
  createGoogleRuntimeOffer,
  createSamsungRuntimeOffer,
  WalletRuntimeError,
} from './runtime.ts';

export interface WalletOffer {
  provider: 'google' | 'samsung';
  href: string;
  installation: 'unknown';
}

const notFound = () =>
  new NotFoundError('This wallet offer is not available.', 'WALLET_OFFER_NOT_FOUND');

/** Lists only capability links. Provider tokens are not created until a holder follows one. */
export async function listWalletOffers(
  ctx: ServiceContext,
  passId: string,
): Promise<WalletOffer[]> {
  if (!walletProviderEnabled('google') && !walletProviderEnabled('samsung')) return [];
  ctx = captureOfferContext(ctx);
  const credentialKeysetCommitment = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const snapshot = await offerPassSnapshot(ctx, passId, credentialKeysetCommitment);
  if (!snapshot) return [];
  const candidates: { eligible: EligibleWalletProvider; offer: WalletOffer }[] = [];
  for (const provider of ['google', 'samsung'] as const) {
    const eligible = await eligibleWalletProvider(ctx, snapshot, provider);
    if (!eligible) continue;
    const instance = await getWalletInstance(ctx.env.DB, {
      orgId: snapshot.pass.orgId,
      mode: snapshot.pass.mode,
      provider,
      passId: snapshot.pass.id,
    });
    if (instance && !(await instanceMatches(ctx, eligible, instance, true))) continue;
    // Neither provider proves a particular holder's installation or removal.
    candidates.push({
      eligible,
      offer: {
        provider,
        href: `/p/${snapshot.pass.downloadToken}/wallet/${provider}`,
        installation: 'unknown',
      },
    });
  }
  const result: WalletOffer[] = [];
  for (const candidate of candidates)
    if (await offerStillCurrent(ctx, candidate.eligible)) result.push(candidate.offer);
  if (
    result.length &&
    ((await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== credentialKeysetCommitment ||
      !(await walletOfferKeysetCurrent(ctx.env.DB, credentialKeysetCommitment)))
  )
    return [];
  return result;
}

/** Resolve the existing pass capability, then atomically issue an instance-bound short-lived offer. */
export async function issueWalletOffer(
  ctx: ServiceContext,
  token: string,
  provider: NativeProvider,
): Promise<string> {
  if (provider !== 'google' && provider !== 'samsung') throw notFound();
  assertWalletProviderEnabled(provider);
  ctx = captureOfferContext(ctx);
  const credentialKeysetCommitment = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const pass = await passForToken(ctx, token);
  const snapshot = await offerPassSnapshot(ctx, pass, credentialKeysetCommitment);
  if (!snapshot) throw notFound();
  const eligible = await eligibleWalletProvider(ctx, snapshot, provider);
  if (!eligible) throw notFound();
  const existing = await getWalletInstance(ctx.env.DB, {
    orgId: pass.orgId,
    mode: pass.mode,
    provider,
    passId: pass.id,
  });
  if (existing && !(await instanceMatches(ctx, eligible, existing, true))) throw notFound();
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
    credentialKeysetCommitment: snapshot.credentialKeysetCommitment,
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
    authority: { kind: 'download', token },
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
      operation.credentialKeysetCommitment !== snapshot.credentialKeysetCommitment ||
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
      // Reference-only saves must never create or overwrite an object from a stale JWT.
      // A successful current sync is the authority that the object was provisioned.
      if (operation.state !== 'succeeded') throw notFound();
      await registerGoogleCallbackBinding(ctx, eligible.runtimeScope, {
        instanceId: instance.id,
        passId: pass.id,
        releaseId: instance.identityProjectionReleaseId,
        credentialGeneration: instance.credentialGeneration,
        operationVersion: operation.version,
      });
      const lifetimeSeconds = Math.min(900, Math.floor((expiresAt - ctx.clock.now()) / 1000) - 1);
      if (lifetimeSeconds < 1) throw notFound();
      const signed = await createGoogleRuntimeOffer(ctx, eligible.runtimeScope, {
        releaseId: instance.identityProjectionReleaseId,
        passId: pass.id,
        credentialGeneration: instance.credentialGeneration,
        origins: [new URL(baseUrl(ctx.env)).origin],
        lifetimeSeconds,
        assertCurrent,
      });
      if (
        !signed.url.startsWith('https://pay.google.com/gp/v/save/') ||
        signed.expiresAt * 1000 > expiresAt ||
        signed.expiresAt * 1000 <= ctx.clock.now()
      )
        throw notFound();
      location = signed.url;
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
    return location;
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
  const credentialKeysetCommitment = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const binding = await consumeWalletOfferRef(
    ctx.env.DB,
    ref,
    ctx.clock.now(),
    credentialKeysetCommitment,
  );
  if (
    binding?.provider !== 'samsung' ||
    binding.credentialKeysetCommitment !== credentialKeysetCommitment
  )
    throw notFound();
  let delivered = false;
  let fenceLost = false;
  try {
    const snapshot = await offerPassSnapshot(ctx, binding.passId, credentialKeysetCommitment);
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
      credentialKeysetCommitment: snapshot.credentialKeysetCommitment,
      operationVersion: binding.version,
      expiresAt: binding.expiresAt,
    });
    if (
      !refId ||
      (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== credentialKeysetCommitment
    )
      throw notFound();
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
