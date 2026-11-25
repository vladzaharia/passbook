import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo-map.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { openPublicAsset } from '../public/service.ts';
import type { PaperFiles } from './paper.ts';
import { MAX_IMAGE_BYTES } from './pdf-png.ts';
import { type ImageSource, MAX_DISTINCT_IMAGES, type RenderOptions } from './pdf-render.ts';

/** PNGs by etag, so a bulk job reads a template's logo and art once, not once per pass. `null`: refused. */
export type ImageCache = Map<string, ImageSource | null>;

/** Reads a body, giving up past `max` bytes so a crafted file never fills the isolate. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

async function load(
  ctx: ServiceContext,
  pass: Pass,
  name: string,
  cache: ImageCache,
): Promise<ImageSource | undefined> {
  try {
    const asset = await openPublicAsset(ctx, pass, name);
    // A member's photo is not the template's art; paper never prints it.
    const known = asset.memberPhoto ? null : cache.get(asset.etag);
    if (asset.memberPhoto || known !== undefined) {
      await asset.body.cancel();
      return known ?? undefined;
    }
    // Past the cap no further image is read: the PDF would leave it out anyway.
    if (cache.size >= MAX_DISTINCT_IMAGES) {
      await asset.body.cancel();
      cache.set(asset.etag, null);
      ctx.log.warn('prints.pdf_image_refused', { code: 'PRINT_PDF_IMAGE_LIMIT', passId: pass.id });
      return undefined;
    }
    const bytes = await readCapped(asset.body, MAX_IMAGE_BYTES);
    if (!bytes) {
      cache.set(asset.etag, null);
      ctx.log.warn('prints.pdf_image_refused', {
        code: 'PRINT_PDF_IMAGE_INVALID',
        passId: pass.id,
      });
      return undefined;
    }
    const source = { id: asset.etag, bytes };
    cache.set(asset.etag, source);
    return source;
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    ctx.log.warn('prints.pdf_image_missing', { code: 'PRINT_PDF_IMAGE_MISSING', passId: pass.id });
    return undefined;
  }
}

/**
 * The pass's own member photo, for a badge or ID. It is the holder's, never the template's art, so
 * it is not cached across passes. A missing or refused photo is left out; the sheet draws initials.
 */
export async function loadPhoto(ctx: ServiceContext, pass: Pass): Promise<ImageSource | undefined> {
  const row = await memberPhoto(ctx.env.DB, pass.orgId, pass.id);
  if (!row) return undefined;
  const object = await ctx.env.BUCKET.get(row.r2_key);
  if (!object) {
    ctx.log.warn('prints.pdf_image_missing', { code: 'PRINT_PDF_IMAGE_MISSING', passId: pass.id });
    return undefined;
  }
  const bytes = await readCapped(object.body, MAX_IMAGE_BYTES);
  if (!bytes) {
    ctx.log.warn('prints.pdf_image_refused', { code: 'PRINT_PDF_IMAGE_INVALID', passId: pass.id });
    return undefined;
  }
  return { id: `photo:${row.sha1}`, bytes };
}

/** The logo, art and photo files of a print, as PNG bytes. A missing file is left out and logged. */
export async function loadImages(
  ctx: ServiceContext,
  pass: Pass,
  files: PaperFiles,
  cache: ImageCache = new Map(),
): Promise<{ logo?: ImageSource; art?: ImageSource; photo?: ImageSource }> {
  const [logo, art, photo] = await Promise.all([
    files.logo ? load(ctx, pass, files.logo, cache) : undefined,
    files.art ? load(ctx, pass, files.art, cache) : undefined,
    files.photo ? loadPhoto(ctx, pass) : undefined,
  ]);
  return { ...(logo ? { logo } : {}), ...(art ? { art } : {}), ...(photo ? { photo } : {}) };
}

/** The `onImageError` that logs a refused image with a stable code. */
export const logImageProblem =
  (ctx: ServiceContext): NonNullable<RenderOptions['onImageError']> =>
  (_id, reason) =>
    ctx.log.warn('prints.pdf_image_refused', {
      code: reason === 'limit' ? 'PRINT_PDF_IMAGE_LIMIT' : 'PRINT_PDF_IMAGE_INVALID',
    });

/**
 * The content identity (etag) of the logo and art, without reading their bytes: a replaced image
 * under the same name changes it, so a cached PDF made with the old one is not served.
 */
export async function imageIds(
  ctx: ServiceContext,
  pass: Pass,
  files: PaperFiles,
): Promise<{ logo?: string; art?: string; photo?: string }> {
  const id = async (name: string | undefined): Promise<string | undefined> => {
    if (!name) return undefined;
    try {
      const asset = await openPublicAsset(ctx, pass, name);
      await asset.body.cancel();
      return asset.memberPhoto ? 'member-photo' : asset.etag;
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error;
      return 'missing';
    }
  };
  const [logo, art, photo] = await Promise.all([
    id(files.logo),
    id(files.art),
    files.photo
      ? memberPhoto(ctx.env.DB, pass.orgId, pass.id).then((r) => (r ? `photo:${r.sha1}` : 'none'))
      : undefined,
  ]);
  return { ...(logo ? { logo } : {}), ...(art ? { art } : {}), ...(photo ? { photo } : {}) };
}
