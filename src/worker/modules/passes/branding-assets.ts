import { crc32 } from '../../../passkit/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { brandingFiles } from '../orgs/branding-files.ts';
import { replacedBy } from './assets.ts';
import type { TenantBranding } from './branding.ts';
import type { AssetRow } from './repo-history-assets.ts';

/** The org's uploaded logo and icon as asset rows (digests read from the stored PNGs). */
async function brandingRows(
  bucket: R2Bucket,
  orgId: string,
  branding: TenantBranding,
): Promise<AssetRow[]> {
  const files = await brandingFiles(bucket, orgId, branding.images);
  return Promise.all(
    files.map(async (f) => {
      const object = await bucket.get(f.r2Key);
      if (!object) throw new NotFoundError(`Image ${f.name} is missing.`, 'ASSET_NOT_FOUND');
      const bytes = new Uint8Array(await object.arrayBuffer());
      return {
        name: f.name,
        r2Key: f.r2Key,
        sha1: await sha1Hex(bytes),
        size: bytes.length,
        width: f.width,
        height: f.height,
        crc32: crc32(bytes),
        createdAt: 0,
      };
    }),
  );
}

/** Org branding fills the slots a per-pass override leaves; overrides win. */
export async function brandedOverrides(
  bucket: R2Bucket,
  orgId: string,
  overrides: AssetRow[],
  branding: TenantBranding,
): Promise<AssetRow[]> {
  if (branding.images.length === 0) return overrides;
  const taken = replacedBy(overrides.map((a) => a.name));
  const rows = await brandingRows(bucket, orgId, branding);
  return [...overrides, ...rows.filter((b) => !taken(b.name))];
}
