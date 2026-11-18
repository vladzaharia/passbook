import type { ServiceContext } from '../../platform/service-context.ts';
import { deleteWalletArt } from './assets.ts';
import { releaseProjectionArt } from './repo-projection-art.ts';

/**
 * Removes the public art copies of a deleted template or organization. A copy is addressed by the
 * hash of its bytes, so two templates with the same art share one object: it is deleted only when
 * no other template still has a row that names it (a shared hash is skipped, not counted). A failed
 * delete is logged and the rest go on; the object is immutable, public template art, so what stays
 * is harmless.
 */
export async function purgeWalletArt(
  ctx: ServiceContext,
  scope: { templateId: string } | { orgId: string },
): Promise<number> {
  const unused = await releaseProjectionArt(ctx.env.DB, scope);
  let removed = 0;
  for (const sha256 of unused) {
    try {
      await deleteWalletArt(ctx.env, sha256);
      removed += 1;
    } catch (error) {
      ctx.log.error('wallet.art_purge_failed', { code: 'WALLET_ART_PURGE', error });
    }
  }
  return removed;
}
