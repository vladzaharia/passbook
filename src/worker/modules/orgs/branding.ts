import type { z } from 'zod';
import { checkImageSize } from '../../../passkit/schema/image-rules.ts';
import type {
  BrandingSlotSchema,
  OrgBrandingSchema,
  OrgDto,
  UploadBrandingImageSchema,
} from '../../../shared/contracts/orgs.ts';
import type { Actor } from '../../platform/context.ts';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { imagesFromBinding } from '../templates/images-binding.ts';
import type { ImageTools } from '../templates/package/images.ts';
import { isPngInfo, parsePng } from '../templates/package/png.ts';
import { brandingKey } from './branding-files.ts';
import { collectSupersededBranding } from './branding-gc.ts';
import { markPassesStale } from './branding-stale.ts';
import type { OrgRow } from './repo.ts';
import { type OrgWriteAuthority, saveOrgBranding } from './repo-org-writes.ts';
import { requireOrg, toDto, withUpdates } from './service.ts';

type Slot = z.infer<typeof BrandingSlotSchema>;
type Branding = z.infer<typeof OrgBrandingSchema>;
type Upload = z.infer<typeof UploadBrandingImageSchema>;

/** Apple's guidance: any pass image at most about 200 KB. */
export const MAX_BRANDING_BYTES = 200 * 1024;
const SCALES = [3, 2] as const;

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Checks one PNG against the passkit image rules at its scale; returns its pixel size. */
export function checkImage(slot: Slot, scale: 2 | 3, bytes: Uint8Array) {
  if (bytes.length > MAX_BRANDING_BYTES)
    throw new ValidationError(`${slot}@${scale}x.png is over 200 KB.`, [], 'IMAGE_BYTES');
  const info = parsePng(bytes);
  if (!isPngInfo(info)) throw new ValidationError(`${slot}: ${info.error}`, [], 'IMAGE_INVALID');
  const { width: w, height: h } = info;
  const verdict = checkImageSize(`${slot}@${scale}x.png`, slot, scale, w, h);
  if (verdict.level === 'error')
    throw new ValidationError(
      verdict.message,
      [{ path: `x${scale}`, message: `Use ${verdict.expected}.`, code: 'IMAGE_SIZE' }],
      'IMAGE_SIZE',
    );
  return { w, h };
}

async function derive2x(
  images: ImageTools,
  bytes: Uint8Array,
  size: { w: number; h: number },
): Promise<Uint8Array | null> {
  const w = Math.round((size.w * 2) / 3);
  const h = Math.round((size.h * 2) / 3);
  return (await images.resize?.(bytes, w, h)) ?? null;
}

async function saveBranding(
  ctx: ServiceContext,
  actor: Actor,
  before: OrgRow,
  branding: Branding,
  detail: Record<string, unknown>,
  authority?: OrgWriteAuthority,
  onCommitResult?: (committed: boolean) => void,
): Promise<OrgDto> {
  const orgId = before.id;
  const now = ctx.clock.now();
  const json = JSON.stringify(branding);
  let saved: OrgRow | null;
  try {
    saved = await saveOrgBranding(ctx, before, json, now, authority);
  } catch (error) {
    // A refused grant rolled back with its batch, so the staged images may be deleted.
    if (error instanceof AppError) onCommitResult?.(false);
    throw error;
  }
  onCommitResult?.(saved !== null);
  if (!saved) throw new ForbiddenError();
  const passesToUpdate = await markPassesStale(ctx, orgId, before, saved);
  await collectSupersededBranding(ctx, orgId, before.branding, saved.branding);
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId,
    action: 'org.update',
    targetType: 'org',
    targetId: orgId,
    detail,
  });
  return withUpdates(toDto(saved), passesToUpdate);
}

/**
 * Stores the org's pass logo or icon in R2 at @3x and @2x. The @2x comes from the client or is
 * derived with the Images binding; without either only the @3x is kept.
 */
export async function putBrandingImage(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  slot: Slot,
  upload: Upload,
  images: ImageTools = imagesFromBinding(ctx.env.IMAGES, ctx.log),
  authority?: OrgWriteAuthority,
): Promise<OrgDto> {
  const current = await requireOrg(ctx, orgId);
  const row = { ...current, config_revision: upload.configRevision ?? current.config_revision };
  const x3 = decode(upload.x3);
  const size = checkImage(slot, 3, x3);
  const x2 = upload.x2 ? decode(upload.x2) : await derive2x(images, x3, size);
  if (x2) {
    const small = checkImage(slot, 2, x2);
    if (Math.abs(small.w - (size.w * 2) / 3) > 1 || Math.abs(small.h - (size.h * 2) / 3) > 1)
      throw new ValidationError('The @2x image must be two thirds of the @3x.', [], 'IMAGE_SCALE');
  }
  // Stage immutable objects before publishing their reference in the fenced org update.
  // A failed or revoked request cannot overwrite images currently used by passes.
  const storageVersion = await sha256Hex(ctx.ids.token());
  const keys = SCALES.map((scale) => brandingKey(orgId, slot, scale, storageVersion));
  let attemptedCommit = false;
  let resolvedCommit = false;
  let committed = false;
  try {
    for (const scale of SCALES) {
      const bytes = scale === 3 ? x3 : x2;
      if (bytes)
        await ctx.env.BUCKET.put(brandingKey(orgId, slot, scale, storageVersion), bytes, {
          httpMetadata: { contentType: 'image/png' },
        });
    }
    const image = { sha: await sha256Hex(x3), ...size, storageVersion };
    const branding = { ...(JSON.parse(row.branding) as Branding), [slot]: image };
    attemptedCommit = true;
    return await saveBranding(
      ctx,
      actor,
      row,
      branding,
      { changes: { [`branding.${slot}`]: { sha: image.sha, ...size } } },
      authority,
      (succeeded) => {
        resolvedCommit = true;
        committed = succeeded;
      },
    );
  } catch (error) {
    // If D1 failed ambiguously, a pass build may hold this version. Delete only when
    // the write definitely did not commit.
    if (!committed && (!attemptedCommit || resolvedCommit))
      await Promise.allSettled(keys.map((key) => ctx.env.BUCKET.delete(key)));
    throw error;
  }
}

export async function deleteBrandingImage(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  slot: Slot,
  authority?: OrgWriteAuthority,
): Promise<OrgDto> {
  const row = await requireOrg(ctx, orgId);
  const { [slot]: _gone, ...branding } = JSON.parse(row.branding) as Branding;
  return saveBranding(
    ctx,
    actor,
    row,
    branding,
    { changes: { [`branding.${slot}`]: null } },
    authority,
  );
}

export async function getBrandingImage(
  ctx: ServiceContext,
  orgId: string,
  slot: Slot,
  scale: 2 | 3,
): Promise<ArrayBuffer> {
  const row = await requireOrg(ctx, orgId);
  const branding = JSON.parse(row.branding) as Partial<Record<Slot, { storageVersion?: string }>>;
  const image = branding[slot];
  if (!image) throw new NotFoundError('Image not found.', 'IMAGE_NOT_FOUND');
  const object = await ctx.env.BUCKET.get(brandingKey(orgId, slot, scale, image.storageVersion));
  if (!object) throw new NotFoundError('Image not found.', 'IMAGE_NOT_FOUND');
  return object.arrayBuffer();
}
