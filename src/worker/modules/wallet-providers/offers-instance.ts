import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { WalletInstance } from './instance.ts';
import {
  type EligibleWalletProvider,
  MAX_CHANNEL_EPOCH,
  type WalletOfferHold,
} from './offers-eligibility.ts';
import { getProjectionRetirementMetadata } from './repo-projection.ts';

/** An existing provider object retains its original class/account identity across revisions. */
export async function instanceMatches(
  ctx: ServiceContext,
  eligible: EligibleWalletProvider,
  instance: WalletInstance,
  allowRestore = false,
): Promise<boolean> {
  const { pass } = eligible.snapshot;
  if (
    instance.passId !== pass.id ||
    instance.orgId !== pass.orgId ||
    instance.mode !== pass.mode ||
    instance.credentialGeneration !== eligible.snapshot.credentialGeneration ||
    instance.provider !== eligible.approved.projection.provider ||
    instance.retirementRequestedAt !== null
  )
    return false;
  // A committed target has no provider identity until its first atomic issuance.
  if (instance.lifecycle === 'ready') return allowRestore && instance.desiredVersion === 0;
  if (
    instance.lifecycle === 'blocked' ||
    instance.lifecycle === 'retired' ||
    (!allowRestore && instance.lifecycle !== 'active') ||
    instance.accountId !== eligible.runtimeScope.accountId
  )
    return false;
  const originReleaseId = instance.identityProjectionReleaseId;
  if (!originReleaseId) return false;
  const origin = await getProjectionRetirementMetadata(ctx.env.DB, originReleaseId);
  return (
    !!origin &&
    origin.orgId === pass.orgId &&
    origin.mode === pass.mode &&
    origin.provider === instance.provider &&
    origin.templateId === pass.templateId &&
    origin.accountId === instance.accountId &&
    origin.providerIdentityHash === eligible.runtimeScope.providerIdentityHash
  );
}

/**
 * A copy retired by a channel-off is replaced by a successor at the holder's next tap. The hold applies
 * while the channel is on: the revoke has not settled, or the epoch limit is reached. Null means the
 * slot is free for a successor.
 */
export function channelOffSuccessor(instance: WalletInstance): {
  hold: WalletOfferHold | null;
  epoch: number;
} | null {
  if (instance.retirementCause !== 'channel_off') return null;
  const settled = instance.lifecycle === 'revoked' || instance.lifecycle === 'retired';
  const hold = !settled
    ? 'provider_retiring'
    : instance.channelEpoch >= MAX_CHANNEL_EPOCH
      ? 'provider_epoch_limit'
      : null;
  return { hold, epoch: instance.channelEpoch + 1 };
}

/**
 * Whether tapping the badge can still activate this slot: the one check listing and issuing share. It mirrors
 * the operation guard (0208): a ready placeholder (a transfer's successor, no operation yet) takes its first
 * operation; a blocked one cannot; a live instance must be at the pass's credential generation. A pending transfer is already refused by the pass snapshot.
 */
export function instanceCanActivate(
  instance: WalletInstance | null,
  passCredentialGeneration: number,
): boolean {
  if (!instance || channelOffSuccessor(instance)) return true;
  if (instance.lifecycle === 'blocked') return false;
  if (instance.lifecycle === 'ready' && instance.desiredVersion !== 0) return false;
  return instance.credentialGeneration === passCredentialGeneration;
}

export const walletOfferNotFound = () =>
  new NotFoundError('This wallet offer is not available.', 'WALLET_OFFER_NOT_FOUND');
