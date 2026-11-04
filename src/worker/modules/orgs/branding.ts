import type { z } from 'zod';
import { checkImageSize } from '../../../passkit/schema/image-rules.ts';
import type {
  BrandingSlotSchema,
  OrgBrandingSchema,
  OrgDto,
  UploadBrandingImageSchema,
} from '../../../shared/contracts/orgs.ts';
import type { Actor } from '../../platform/context.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { imagesFromBinding } from '../templates/images-binding.ts';
import type { ImageTools } from '../templates/package/images.ts';
import { isPngInfo, parsePng } from '../templates/package/png.ts';
import { brandingKey } from './branding-files.ts';
import { markPassesStale } from './branding-stale.ts';
import { type OrgRow, setOrgBranding } from './repo.ts';
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
): Promise<OrgDto> {
  const orgId = before.id;
  const now = ctx.clock.now();
  const json = JSON.stringify(branding);
  await setOrgBranding(ctx.env.DB, orgId, json, now);
  const passesToUpdate = await markPassesStale(ctx, orgId, before, { ...before, branding: json });
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId,
    action: 'org.update',
    targetType: 'org',
    targetId: orgId,
    detail,
  });
  return withUpdates(toDto({ ...(await requireOrg(ctx, orgId)), updated_at: now }), passesToUpdate);
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
): Promise<OrgDto> {
  const row = await requireOrg(ctx, orgId);
  const x3 = decode(upload.x3);
  const size = checkImage(slot, 3, x3);
  const x2 = upload.x2 ? decode(upload.x2) : await derive2x(images, x3, size);
  if (x2) {
    const small = checkImage(slot, 2, x2);
    if (Math.abs(small.w - (size.w * 2) / 3) > 1 || Math.abs(small.h - (size.h * 2) / 3) > 1)
      throw new ValidationError('The @2x image must be two thirds of the @3x.', [], 'IMAGE_SCALE');
  }
  for (const scale of SCALES) {
    const bytes = scale === 3 ? x3 : x2;
    const key = brandingKey(orgId, slot, scale);
    if (bytes) await ctx.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
    else await ctx.env.BUCKET.delete(key);
  }
  const image = { sha: await sha256Hex(x3), ...size };
  const branding = { ...(JSON.parse(row.branding) as Branding), [slot]: image };
  return saveBranding(ctx, actor, row, branding, { changes: { [`branding.${slot}`]: image } });
}

export async function deleteBrandingImage(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  slot: Slot,
): Promise<OrgDto> {
  const row = await requireOrg(ctx, orgId);
  const { [slot]: _gone, ...branding } = JSON.parse(row.branding) as Branding;
  for (const scale of SCALES) await ctx.env.BUCKET.delete(brandingKey(orgId, slot, scale));
  return saveBranding(ctx, actor, row, branding, { changes: { [`branding.${slot}`]: null } });
}

export async function getBrandingImage(
  ctx: ServiceContext,
  orgId: string,
  slot: Slot,
  scale: 2 | 3,
): Promise<ArrayBuffer> {
  await requireOrg(ctx, orgId);
  const object = await ctx.env.BUCKET.get(brandingKey(orgId, slot, scale));
  if (!object) throw new NotFoundError('Image not found.', 'IMAGE_NOT_FOUND');
  return object.arrayBuffer();
}
