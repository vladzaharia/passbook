export type BrandingSlot = 'logo' | 'icon';

/** Legacy uploads used stable keys; new uploads are immutable and referenced by version. */
export const brandingKey = (
  orgId: string,
  slot: BrandingSlot,
  scale: 2 | 3,
  storageVersion?: string,
) =>
  storageVersion
    ? `orgs/${orgId}/branding/versions/${storageVersion}/${slot}@${scale}x.png`
    : `orgs/${orgId}/branding/${slot}@${scale}x.png`;

/** One stored org pass image: a slot at a scale that exists in R2. */
export interface BrandingFile {
  /** The pass package name, e.g. `logo@3x.png`. */
  name: string;
  slot: BrandingSlot;
  r2Key: string;
  size: number;
  width: number;
  height: number;
  /** Immutable object version, or the @3x digest for a legacy stable-key upload. */
  version: string;
}

export interface BrandingImageRef {
  slot: BrandingSlot;
  sha: string;
  w: number;
  h: number;
  /** Absent on existing uploads stored at the legacy stable key. */
  storageVersion?: string | undefined;
}

/**
 * The org's uploaded pass images as the files that exist in R2. Pass builds, the pass page and the
 * pass email all read this, so they agree on which logo and icon an org's passes carry.
 */
export async function brandingFiles(
  bucket: Pick<R2Bucket, 'head'>,
  orgId: string,
  images: readonly BrandingImageRef[],
): Promise<BrandingFile[]> {
  const found = await Promise.all(
    images.flatMap((image) =>
      ([3, 2] as const).map(async (scale): Promise<BrandingFile | null> => {
        const r2Key = brandingKey(orgId, image.slot, scale, image.storageVersion);
        const head = await bucket.head(r2Key);
        if (!head) return null;
        const f = scale === 3 ? 1 : 2 / 3;
        return {
          name: `${image.slot}@${scale}x.png`,
          slot: image.slot,
          r2Key,
          size: head.size,
          width: Math.round(image.w * f),
          height: Math.round(image.h * f),
          version: image.storageVersion ?? image.sha,
        };
      }),
    ),
  );
  return found.filter((f): f is BrandingFile => f !== null);
}
