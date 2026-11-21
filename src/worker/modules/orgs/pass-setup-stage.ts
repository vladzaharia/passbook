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
import { queueBrandingKeys, queueStagedKeys } from './repo-branding-gc.ts';

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

/** Staged keys are queued this long past the advertised `expiresAt`, so a save at the deadline still finds them. */
const SLACK_MS = 3_600_000;

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/**
 * Stores a checked PNG under a content-addressed key and queues it for the sweep, which deletes it after the
 * grace period unless a save has named it by then. A logo or icon is stored under a version that covers both
 * scales, so staging can never replace a file a pass already uses. The queue row comes first, so a failed put
 * leaves nothing to leak.
 */
export async function stageBrandAsset(
  ctx: ServiceContext,
  orgId: string,
  input: z.infer<typeof StageBrandAssetSchema>,
): Promise<StagedBrandAsset> {
  const bucket = ctx.env.BUCKET;
  const at = ctx.clock.now() + SLACK_MS;
  const queue = async (keys: string[]) => {
    if (!(await queueStagedKeys(ctx.env.DB, orgId, keys, at, STAGED_CAP)))
      throw new RateLimitedError(
        3600,
        'Too many uploads are waiting. Save one, or try again later.',
      );
  };
  let sha: string;
  let version: string;
  let size: { w: number; h: number };
  if (input.slot === 'webLogo') {
    const bytes = decode(input.png);
    size = checkWebLogo(bytes);
    sha = version = await sha256Hex(bytes);
    const key = webLogoKey(orgId, sha);
    await queue([key]);
    await bucket.put(key, bytes, png);
  } else {
    const slot = input.slot;
    const images = imagesFromBinding(ctx.env.IMAGES, ctx.log);
    const pair = await checkedImagePair(images, slot, { x3: input.png, x2: input.x2 });
    size = pair.size;
    sha = await sha256Hex(pair.x3);
    // Without an @2x the version is the sha itself: the one file is the public image's own bytes.
    version = pair.x2 ? await sha256Hex(concat(pair.x3, pair.x2)) : sha;
    const keys = [brandingKey(orgId, slot, 3, version)];
    if (pair.x2) keys.push(brandingKey(orgId, slot, 2, version));
    await queue(keys);
    await bucket.put(keys[0] as string, pair.x3, png);
    if (pair.x2) await bucket.put(keys[1] as string, pair.x2, png);
  }
  return {
    slot: input.slot,
    sha,
    version,
    ...size,
    expiresAt: ctx.clock.now() + BRANDING_GC_GRACE_MS,
  };
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
  const primary: [string, string][] = [];
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
      primary.push([key, path]);
    } else {
      const version = ref.version ?? ref.sha;
      const key = brandingKey(orgId, slot, 3, version);
      const x3 = await stagedBytes(ctx.env.BUCKET, key, ref.sha, path);
      const size = checkImage(slot, 3, x3);
      const key2 = brandingKey(orgId, slot, 2, version);
      if (version !== ref.sha) {
        // The version is the digest of both scales: the @2x must be the one that was staged.
        const x2 = await ctx.env.BUCKET.get(key2);
        const bytes2 = x2 ? new Uint8Array(await x2.arrayBuffer()) : null;
        if (!bytes2 || (await sha256Hex(concat(x3, bytes2))) !== version) throw missing(path);
      }
      out[slot] = { sha: ref.sha, ...size, storageVersion: version };
      named.push(key, key2);
      primary.push([key, path]);
    }
  }
  if (keep && named.length) {
    await queueBrandingKeys(ctx.env.DB, orgId, named, ctx.clock.now() + SLACK_MS);
    // A sweep may have deleted one between the read and the requeue: look again before the save commits.
    for (const [key, path] of primary) if (!(await ctx.env.BUCKET.head(key))) throw missing(path);
  }
  return out;
}
