import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo-map.ts';
import { type PrintAudience, printPageModel } from './page.ts';
import { fallbackPdf } from './pdf-fallback.ts';
import { cachedPdf, pdfKey, putPdf } from './pdf-store.ts';

export const PDF_HEADERS = {
  'content-type': 'application/pdf',
  'cache-control': 'private, no-store',
  'content-disposition': 'attachment; filename="ticket.pdf"',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};

/**
 * The PDF of the pass's active print. The model read is the authorization: it needs paper on for
 * the pass, an active print and, for a holder, the template's `holder` flag; the caller has already
 * proved the link or the org. A hit returns the R2 copy drawn from this pass version.
 */
export async function ticketPdf(
  ctx: ServiceContext,
  pass: Pass,
  audience: PrintAudience,
): Promise<Uint8Array | ReadableStream> {
  const model = await printPageModel(ctx, pass, audience);
  if (model.state !== 'ready') throw new NotFoundError('No active print.', 'PRINT_NOT_FOUND');
  const key = pdfKey(pass.orgId, pass.id, model.printId);
  const hit = await cachedPdf(ctx.env.BUCKET, key, pass.version);
  if (hit) return hit.body;
  const bytes = await fallbackPdf(
    [{ design: model.design, content: model.content, code: model.code }],
    () => ctx.log.warn('prints.pdf_lossy_text', { code: 'PRINT_PDF_TEXT_LOSSY' }),
  );
  await putPdf(ctx.env.BUCKET, key, bytes, { passVersion: pass.version });
  return bytes;
}
