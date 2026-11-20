import { OrgBrandingSchema } from '../../../shared/contracts/orgs.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { scanLogoOf } from '../orgs/brand.ts';
import { brandingKey, webLogoKey } from '../orgs/branding-files.ts';
import { readBranding } from '../passes/branding.ts';
import type { ScanActor } from './actor.ts';
import { SESSION_READ, scanReadAuthority } from './repo-read-authority.ts';
import { orgBrandingForActorStmt } from './repo-session.ts';
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
  const auth = scanReadAuthority(actor, { now: ctx.clock.now(), read: SESSION_READ });
  // Only a lost credential unpairs; drift is a 409 the client reloads.
  const row = await orgBrandingForActorStmt(db, auth).first<{ branding: string | null }>();
  if (!row) throw await staleScanRead(ctx, actor);
  const stored = row.branding;
  const parsed = stored ? JSON.parse(stored) : {};
  const web = OrgBrandingSchema.safeParse(parsed);
  const chosen = web.success ? scanLogoOf(web.data) : null;
  const logo = readBranding(parsed).images.find((image) => image.slot === 'logo');
  // The web logo is content-addressed; the pass logo is a versioned @3x.
  const key =
    chosen?.slot === 'web'
      ? webLogoKey(actor.orgId, chosen.image.sha)
      : logo
        ? brandingKey(actor.orgId, 'logo', 3, logo.storageVersion)
        : null;
  if (!key) throw missing();
  const image = await ctx.env.BUCKET.get(key);
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
