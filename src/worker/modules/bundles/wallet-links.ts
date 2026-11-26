import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import { revealToken } from '../../platform/capability-token.ts';
import { AppError, NotFoundError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo.ts';
import {
  issueWalletOffer,
  issueWalletOfferScoped,
  listWalletOffers,
} from '../wallet-providers/offers.ts';
import type { WalletRuntimeScope } from '../wallet-providers/runtime.ts';
import { combineGoogleRuntimeOffers } from '../wallet-providers/runtime-google-bundle.ts';
import {
  addablePass,
  assertBundleMember,
  assertBundleMembers,
  bundleMembers,
} from './public-service.ts';
import type { BundleRow } from './repo.ts';

const notFound = () => new NotFoundError('This link is not valid.', 'LINK_NOT_FOUND');

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
  await assertBundleMember(ctx, bundle, pass);
  const token = await revealToken(ctx.env, 'pass', pass.id, pass.orgId, pass.downloadToken);
  const location = await issueWalletOffer(ctx, token, provider);
  await assertBundleMember(ctx, bundle, pass);
  return location;
}

/** Objects per Google save link: the most that fit its 1,800-character limit with room to spare. */
export const GOOGLE_BUNDLE_LINK_SIZE = 8;

/** How many save links the bundle's Google-offered members need. */
export const googleBundleParts = (offered: number) =>
  offered < 2 ? 0 : Math.ceil(offered / GOOGLE_BUNDLE_LINK_SIZE);

/**
 * One Google save link for part `part` of the bundle: each member's own offer is issued under its own
 * fences, then the objects are signed into a single link. A member Google is not ready for makes the
 * whole link 503 (the first tap is still preparing it); a member without an offer is left out.
 */
export async function bundleGoogleLocation(
  ctx: ServiceContext,
  bundle: BundleRow,
  part: number,
): Promise<string> {
  const members = await bundleMembers(ctx, bundle);
  const offered: Pass[] = [];
  for (const { pass } of members)
    if ((await bundleWalletProviders(ctx, pass)).includes('google')) offered.push(pass);
  const chunk = offered.slice(part * GOOGLE_BUNDLE_LINK_SIZE, (part + 1) * GOOGLE_BUNDLE_LINK_SIZE);
  if (chunk.length === 0) throw notFound();
  const issued = await Promise.allSettled(
    chunk.map(async (pass) => {
      const token = await revealToken(ctx.env, 'pass', pass.id, pass.orgId, pass.downloadToken);
      return issueWalletOfferScoped(ctx, token, 'google');
    }),
  );
  const links: { location: string; scope: WalletRuntimeScope }[] = [];
  for (const result of issued) {
    if (result.status === 'fulfilled') links.push(result.value);
    else if (result.reason instanceof UnavailableError) throw result.reason;
    else if (!(result.reason instanceof AppError && result.reason.status === 404))
      throw result.reason;
  }
  const [first] = links;
  if (!first) throw notFound();
  let location = first.location;
  if (links.length > 1) {
    const scope = first.scope;
    if (
      links.some(
        (l) =>
          l.scope.accountId !== scope.accountId ||
          l.scope.accountRevision !== scope.accountRevision,
      )
    )
      throw notFound();
    location = (
      await combineGoogleRuntimeOffers(
        ctx,
        scope,
        links.map((l) => l.location),
      )
    ).url;
  }
  await assertBundleMembers(ctx, bundle, chunk);
  return location;
}
