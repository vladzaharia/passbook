import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import { revealToken } from '../../platform/capability-token.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo.ts';
import { issueWalletOffer, listWalletOffers } from '../wallet-providers/offers.ts';
import { addablePass, assertBundleMember } from './public-service.ts';
import type { BundleRow } from './repo.ts';

export const bundleWalletHref = (bundleToken: string, passId: string, provider: WalletProvider) =>
  `/b/${bundleToken}/${passId}/wallet/${provider}`;

/**
 * The native wallets a member can be saved to, as bundle-scoped paths. Only what the pass's own
 * offer list allows (release, enrolment, channel, approval) appears; the pass link never leaves
 * the server.
 */
export async function bundleWalletProviders(
  ctx: ServiceContext,
  pass: Pass,
): Promise<WalletProvider[]> {
  if (pass.status !== 'active' || pass.removedAt !== null) return [];
  return (await listWalletOffers(ctx, pass.id)).map((offer) => offer.provider);
}

/** The provider's save location for one member: the same offer a pass link would issue. */
export async function bundleWalletLocation(
  ctx: ServiceContext,
  bundle: BundleRow,
  passId: string,
  provider: WalletProvider,
): Promise<string> {
  const pass = await addablePass(ctx, bundle, passId);
  const token = await revealToken(ctx.env, 'pass', pass.id, pass.orgId, pass.downloadToken);
  const location = await issueWalletOffer(ctx, token, provider);
  await assertBundleMember(ctx, bundle, pass);
  return location;
}
