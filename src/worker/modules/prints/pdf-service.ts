import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo-map.ts';
import { type PrintAudience, type PrintPageModel, printPageModel } from './page.ts';
import { pdfFingerprint } from './pdf-cache.ts';
import { imageIds, loadImages, logImageProblem } from './pdf-images.ts';
import { type PrintSheet, renderPdf } from './pdf-render.ts';
import { cachedPdf, pdfKey, putPdf } from './pdf-store.ts';

export const PDF_HEADERS = {
  'content-type': 'application/pdf',
  'cache-control': 'private, no-store',
  'content-disposition': 'attachment; filename="ticket.pdf"',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};

type Ready = Extract<PrintPageModel, { state: 'ready' }>;

/** The sheet a ready print draws, without its images. */
export const sheetOf = (model: Ready): PrintSheet => ({
  design: model.design,
  content: model.content,
  code: model.code,
  mode: model.mode,
  mark: model.mark,
  issued: { generation: model.generation, at: new Date(model.printedAt).toISOString() },
});

/**
 * The PDF of the pass's active print. The model read is the authorization: it needs paper on for
 * the pass, an active print and, for a holder, the template's `holder` flag; the caller has already
 * proved the link or the org. A hit returns the R2 copy drawn from this pass version and these inputs.
 */
export async function ticketPdf(
  ctx: ServiceContext,
  pass: Pass,
  audience: PrintAudience,
): Promise<Uint8Array | ReadableStream> {
  const model = await printPageModel(ctx, pass, audience);
  if (model.state !== 'ready') throw new NotFoundError('No active print.', 'PRINT_NOT_FOUND');
  const key = pdfKey(pass.orgId, pass.id, model.printId, audience);
  const fingerprint = await pdfFingerprint({
    sheet: sheetOf(model),
    images: await imageIds(ctx, pass, model.files),
    template: [pass.templateId, pass.templateVersion],
  });
  const hit = await cachedPdf(ctx.env.BUCKET, key, pass.version, fingerprint);
  if (hit) return hit.body;
  const images = await loadImages(ctx, pass, model.files);
  const bytes = await renderPdf([{ ...sheetOf(model), images }], {
    assets: ctx.env.ASSETS,
    onLossy: () => ctx.log.warn('prints.pdf_lossy_text', { code: 'PRINT_PDF_TEXT_LOSSY' }),
    onImageError: logImageProblem(ctx),
  });
  await putPdf(ctx.env.BUCKET, key, bytes, { passVersion: pass.version, fingerprint });
  return bytes;
}
