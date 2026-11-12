import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { brandingKey } from '../orgs/branding-files.ts';
import { readBranding } from '../passes/branding.ts';
import type { ScanActor } from './actor.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';
import { orgBrandingStmt } from './repo-session.ts';
import {
  packedScanAuthorityPredicate,
  sessionReadAuthorityPredicate,
} from './repo-session-authority.ts';
import { staleScanRead } from './stale-read.ts';

const missing = () => new NotFoundError('Image not found.', 'IMAGE_NOT_FOUND');

/**
 * The actor's own org logo at @3x. The org comes from the guarded actor, never the request, and
 * the branding row is read in the same batch as the session-read authority check.
 */
export async function openScanBrandingLogo(
  ctx: ServiceContext,
  actor: ScanActor,
  ifNoneMatch: string | undefined,
): Promise<Response> {
  const db = ctx.env.DB;
  const authority = packedScanAuthorityPredicate(
    actor,
    sessionReadAuthorityPredicate(actor, ctx.clock.now()),
  );
  // Only a lost credential unpairs; drift is a 409 the client reloads.
  if (authority.sql === '0') throw await staleScanRead(ctx, actor);
  const [status, row] = await db.batch([
    outputPredicateStmt(db, authority),
    orgBrandingStmt(db, actor.orgId),
  ]);
  if ((status?.results?.[0] as { authorized?: number } | undefined)?.authorized !== 1)
    throw await staleScanRead(ctx, actor);
  const stored = (row?.results?.[0] as { branding?: string } | undefined)?.branding;
  const logo = readBranding(stored ? JSON.parse(stored) : {}).images.find(
    (image) => image.slot === 'logo',
  );
  if (!logo) throw missing();
  const image = await ctx.env.BUCKET.get(brandingKey(actor.orgId, 'logo', 3, logo.storageVersion));
  if (!image) throw missing();
  const headers = {
    'content-type': 'image/png',
    'cache-control': 'private, no-cache',
    etag: image.httpEtag,
    'x-content-type-options': 'nosniff',
  };
  if (ifNoneMatch === image.httpEtag) {
    await image.body.cancel();
    return new Response(null, { status: 304, headers });
  }
  return new Response(image.body, { headers });
}
