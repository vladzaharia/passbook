import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo-map.ts';
import { openPublicAsset } from '../public/service.ts';
import type { PaperFiles } from './paper.ts';
import type { ImageSource } from './pdf-render.ts';

/** PNGs by etag, so a bulk job reads a template's logo and art once, not once per pass. */
export type ImageCache = Map<string, ImageSource>;

async function load(
  ctx: ServiceContext,
  pass: Pass,
  name: string,
  cache: ImageCache,
): Promise<ImageSource | undefined> {
  try {
    const asset = await openPublicAsset(ctx, pass, name);
    // A member's photo is not the template's art; paper never prints it.
    const hit = asset.memberPhoto ? undefined : cache.get(asset.etag);
    if (asset.memberPhoto || hit) {
      await asset.body.cancel();
      return hit;
    }
    const bytes = new Uint8Array(await new Response(asset.body).arrayBuffer());
    const source = { id: asset.etag, bytes };
    cache.set(asset.etag, source);
    return source;
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    ctx.log.warn('prints.pdf_image_missing', { code: 'PRINT_PDF_IMAGE_MISSING', passId: pass.id });
    return undefined;
  }
}

/** The logo and art files of a print, as PNG bytes. A missing file is left out and logged. */
export async function loadImages(
  ctx: ServiceContext,
  pass: Pass,
  files: PaperFiles,
  cache: ImageCache = new Map(),
): Promise<{ logo?: ImageSource; art?: ImageSource }> {
  const [logo, art] = await Promise.all([
    files.logo ? load(ctx, pass, files.logo, cache) : undefined,
    files.art ? load(ctx, pass, files.art, cache) : undefined,
  ]);
  return { ...(logo ? { logo } : {}), ...(art ? { art } : {}) };
}
