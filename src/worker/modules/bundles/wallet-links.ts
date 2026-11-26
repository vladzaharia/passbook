import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import { revealToken } from '../../platform/capability-token.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo.ts';
import { GoogleWalletError } from '../wallet-providers/google-errors.ts';
import {
  issueWalletOffer,
  issueWalletOfferScoped,
  listWalletOffers,
  type ScopedWalletOffer,
} from '../wallet-providers/offers.ts';
import { GoogleMemberFailedError } from '../wallet-providers/offers-google.ts';
import { WalletRuntimeError } from '../wallet-providers/runtime.ts';
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

/**
 * Objects per Google save link. Sized so the longest link the validators accept (a 32-digit issuer, a
 * 119-character service-account email, five object types) stays under Google's 1,800-character limit.
 */
export const GOOGLE_BUNDLE_LINK_SIZE = 6;

/** How many save links the bundle's Google-offered members need: the page and the route both ask this. */
export const googleBundleParts = (offered: number) =>
  offered < 2 ? 0 : Math.ceil(offered / GOOGLE_BUNDLE_LINK_SIZE);

/**
 * One Google save link for part `part` of the bundle: each member's own offer is issued under its own
 * fences, then the objects are signed into a single link. A member Google is still preparing makes the
 * link 503 (retry); one whose operation failed for good, or with no offer, is left out. Copies are recorded
 * only for members the delivered link carries.
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
  if (part >= googleBundleParts(offered.length)) throw notFound();
  const chunk = offered.slice(part * GOOGLE_BUNDLE_LINK_SIZE, (part + 1) * GOOGLE_BUNDLE_LINK_SIZE);
  const issued = await Promise.allSettled(
    chunk.map(async (pass) => {
      const token = await revealToken(ctx.env, 'pass', pass.id, pass.orgId, pass.downloadToken);
      return {
        pass,
        offer: await issueWalletOfferScoped(ctx, token, 'google', { deferCopy: true }),
      };
    }),
  );
  const links: { pass: Pass; offer: ScopedWalletOffer }[] = [];
  for (const result of issued) {
    if (result.status === 'fulfilled') {
      links.push(result.value);
      continue;
    }
    const error = result.reason;
    if (error instanceof GoogleMemberFailedError)
      ctx.log.warn('wallet.google_bundle_member_failed', {
        code: 'WALLET_GOOGLE_BUNDLE_MEMBER_FAILED',
        orgId: bundle.org_id,
      });
    else if (!(error instanceof AppError && error.status === 404)) throw error;
  }
  const [first] = links;
  if (!first) throw notFound();
  let location = first.offer.location;
  if (links.length > 1) {
    const scope = first.offer.scope;
    const objects = links.map((l) => l.offer.google);
    const same = links.every(
      (l) =>
        l.offer.scope.accountId === scope.accountId &&
        l.offer.scope.accountRevision === scope.accountRevision,
    );
    if (!same || objects.some((o) => !o)) {
      ctx.log.warn('wallet.google_bundle_scope_mismatch', {
        code: 'WALLET_GOOGLE_BUNDLE_SCOPE',
        orgId: bundle.org_id,
      });
      throw notFound();
    }
    try {
      location = await combineGoogleRuntimeOffers(
        ctx,
        scope,
        objects.filter((o) => o !== undefined),
        // Each member's own currency, again at sign time: first taps ran in parallel and may be old.
        async () => {
          for (const l of links) await l.offer.recheck();
        },
      );
    } catch (error) {
      if (
        error instanceof AppError ||
        (error instanceof WalletRuntimeError && error.code === 'account_unavailable') ||
        error instanceof GoogleWalletError
      ) {
        ctx.log.warn('wallet.google_bundle_link_failed', {
          code: 'WALLET_GOOGLE_BUNDLE_LINK',
          orgId: bundle.org_id,
        });
        if (error instanceof AppError) throw error;
        throw notFound();
      }
      throw error;
    }
  }
  await assertBundleMembers(
    ctx,
    bundle,
    links.map((l) => l.pass),
  );
  for (const l of links) await l.offer.recordCopy();
  return location;
}
