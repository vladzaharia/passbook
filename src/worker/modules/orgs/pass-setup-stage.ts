import type { z } from 'zod';
import type { OrgBrandingSchema } from '../../../shared/contracts/orgs.ts';
import type {
  BrandAssetSlotSchema,
  PassSetupPatch,
  StageBrandAssetSchema,
  StagedBrandAsset,
} from '../../../shared/contracts/pass-setup.ts';
import { RateLimitedError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { imagesFromBinding } from '../templates/images-binding.ts';
import { checkWebLogo } from './brand-web.ts';
import { checkedImagePair, checkImage } from './branding.ts';
import { brandingKey, webLogoKey } from './branding-files.ts';
import { BRANDING_GC_GRACE_MS } from './branding-gc.ts';
import { queueBrandingKeys, queuedBrandingCount } from './repo-branding-gc.ts';

type Branding = z.infer<typeof OrgBrandingSchema>;
type Image = NonNullable<Branding['logo']> & { storageVersion?: string };
type Slot = z.infer<typeof BrandAssetSlotSchema>;

/** Staged uploads and superseded objects an org may have waiting for the daily sweep. */
export const STAGED_CAP = 100;

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const png = { httpMetadata: { contentType: 'image/png' } };

const missing = (path: string) =>
  new ValidationError(
    'That upload is not staged or has expired. Upload it again.',
    [{ path, message: 'Not staged.', code: 'BRAND_ASSET_NOT_FOUND' }],
    'BRAND_ASSET_NOT_FOUND',
  );

/**
 * Stores a checked PNG content-addressed and queues it for the sweep, which deletes it after the grace
 * period unless a save has named it by then. Nothing about the org changes.
 */
export async function stageBrandAsset(
  ctx: ServiceContext,
  orgId: string,
  input: z.infer<typeof StageBrandAssetSchema>,
): Promise<StagedBrandAsset> {
  if ((await queuedBrandingCount(ctx.env.DB, orgId)) >= STAGED_CAP)
    throw new RateLimitedError(3600, 'Too many uploads are waiting. Save one, or try again later.');
  const bucket = ctx.env.BUCKET;
  let keys: string[];
  let sha: string;
  let size: { w: number; h: number };
  if (input.slot === 'webLogo') {
    const bytes = decode(input.png);
    size = checkWebLogo(bytes);
    sha = await sha256Hex(bytes);
    keys = [webLogoKey(orgId, sha)];
    await bucket.put(keys[0] as string, bytes, png);
  } else {
    const slot = input.slot;
    const images = imagesFromBinding(ctx.env.IMAGES, ctx.log);
    const {
      x3,
      x2,
      size: found,
    } = await checkedImagePair(images, slot, {
      x3: input.png,
      x2: input.x2,
    });
    size = found;
    sha = await sha256Hex(x3);
    // The object version is the digest, so a save names the upload by its sha alone.
    keys = [brandingKey(orgId, slot, 3, sha), brandingKey(orgId, slot, 2, sha)];
    await bucket.put(keys[0] as string, x3, png);
    if (x2) await bucket.put(keys[1] as string, x2, png);
    else keys.pop();
  }
  // Queued before any save can name it: the sweep keeps what the org's branding references.
  await queueBrandingKeys(ctx.env.DB, orgId, keys, ctx.clock.now());
  return { slot: input.slot, sha, ...size, expiresAt: ctx.clock.now() + BRANDING_GC_GRACE_MS };
}

async function stagedBytes(bucket: R2Bucket, key: string, sha: string, path: string) {
  const object = await bucket.get(key);
  if (!object) throw missing(path);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(bytes)) !== sha) throw missing(path);
  return bytes;
}

export type StagedImages = Partial<Record<Slot, Image | null>>;

/**
 * The images a save names: each `{ sha }` must be a staged upload of that slot, still stored and intact.
 * `null` clears the slot. With `keep`, a named upload is queued again, so the sweep leaves it alone while the save commits.
 */
export async function resolveStaged(
  ctx: ServiceContext,
  orgId: string,
  brand: NonNullable<PassSetupPatch['brand']>,
  keep = true,
): Promise<StagedImages> {
  const out: StagedImages = {};
  const named: string[] = [];
  for (const slot of ['logo', 'icon', 'webLogo'] as const) {
    const ref = brand[slot];
    if (ref === undefined) continue;
    if (ref === null) {
      out[slot] = null;
      continue;
    }
    const path = `brand.${slot}`;
    if (slot === 'webLogo') {
      const key = webLogoKey(orgId, ref.sha);
      out[slot] = {
        sha: ref.sha,
        ...checkWebLogo(await stagedBytes(ctx.env.BUCKET, key, ref.sha, path)),
      };
      named.push(key);
    } else {
      const key = brandingKey(orgId, slot, 3, ref.sha);
      const size = checkImage(slot, 3, await stagedBytes(ctx.env.BUCKET, key, ref.sha, path));
      out[slot] = { sha: ref.sha, ...size, storageVersion: ref.sha };
      named.push(key, brandingKey(orgId, slot, 2, ref.sha));
    }
  }
  if (keep && named.length) await queueBrandingKeys(ctx.env.DB, orgId, named, ctx.clock.now());
  return out;
}
