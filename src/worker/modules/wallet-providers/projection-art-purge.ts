import type { ServiceContext } from '../../platform/service-context.ts';
import { deleteWalletArt } from './assets.ts';
import {
  type ArtScope,
  forgetProjectionArt,
  listProjectionArt,
  orgHasLivePasses,
} from './repo-projection-art.ts';

/**
 * Removes the public art copies of a deleted template or organization. A copy is addressed by the
 * hash of its bytes, so two templates with the same art share one object: it is deleted only when
 * no other template or organization has a candidate that records it (a shared hash is skipped, not
 * counted). The object goes first and the tracking row after, so a failed delete leaves the row
 * and the next purge of the scope retries it. Never throws: the deletion that triggered it has
 * committed; a failure is logged and what stays is immutable, public template art.
 */
export async function purgeWalletArt(ctx: ServiceContext, scope: ArtScope): Promise<number> {
  let removed = 0;
  try {
    for (const { sha256, shared } of await listProjectionArt(ctx.env.DB, scope)) {
      try {
        if (!shared) {
          await deleteWalletArt(ctx.env, sha256);
          removed += 1;
        }
        await forgetProjectionArt(ctx.env.DB, scope, sha256);
      } catch (error) {
        ctx.log.error('wallet.art_purge_failed', { code: 'WALLET_ART_PURGE', error });
      }
    }
  } catch (error) {
    ctx.log.error('wallet.art_purge_failed', { code: 'WALLET_ART_PURGE', error });
  }
  return removed;
}

/**
 * An organization is only soft-deleted: its passes keep their org. While one can still present a
 * wallet object the art stays. No organization-level hard purge exists yet; when it does, it calls
 * `purgeWalletArt` with the org id, and so does this once the last live pass is gone.
 */
export async function purgeOrgWalletArt(ctx: ServiceContext, orgId: string): Promise<number> {
  try {
    if (await orgHasLivePasses(ctx.env.DB, orgId)) return 0;
  } catch (error) {
    ctx.log.error('wallet.art_purge_failed', { code: 'WALLET_ART_PURGE', error });
    return 0;
  }
  return purgeWalletArt(ctx, { orgId });
}
