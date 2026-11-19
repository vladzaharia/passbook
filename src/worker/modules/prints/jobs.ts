import type { JobOf } from '../../jobs/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type PrintSheet, renderPrintSheets } from '../../ssr/print-sheets.tsx';
import { getPass } from '../passes/repo-read-pass.ts';
import { readBulkStatus, writeBulkStatus } from './bulk-status.ts';
import { printPageModel } from './page.ts';
import { fallbackPdf } from './pdf-fallback.ts';
import { renderPdf } from './pdf-render.ts';
import { bulkKey, putPdf } from './pdf-store.ts';

/**
 * Renders the combined PDF of a bulk Print: one browser launch for the whole selection. A busy
 * browser throws, and the queue retries with backoff; a pass whose print ended meanwhile is left out.
 */
export async function handlePrintsBulk(job: JobOf<'prints.bulk'>, ctx: ServiceContext) {
  const bucket = ctx.env.BUCKET;
  const known = await readBulkStatus(bucket, job.orgId, job.jobId, ctx.clock.now());
  if (known && known.state !== 'pending') return;
  const sheets: PrintSheet[] = [];
  for (const passId of job.passIds) {
    const pass = await getPass(ctx.env.DB, passId, job.orgId);
    if (!pass) continue;
    try {
      const model = await printPageModel(ctx, pass, 'staff');
      if (model.state === 'ready')
        sheets.push({ design: model.design, content: model.content, code: model.code });
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error;
    }
  }
  const at = ctx.clock.now();
  if (sheets.length === 0) {
    await writeBulkStatus(bucket, job.orgId, job.jobId, { state: 'failed', count: 0, at });
    return;
  }
  const { bytes, engine } = await renderPdf(ctx, {
    html: renderPrintSheets(sheets),
    fallback: () =>
      fallbackPdf(sheets, () =>
        ctx.log.warn('prints.pdf_lossy_text', { code: 'PRINT_PDF_TEXT_LOSSY' }),
      ),
    whenBusy: 'retry',
  });
  await putPdf(bucket, bulkKey(job.orgId, job.jobId, 'pdf'), bytes, { engine });
  await writeBulkStatus(bucket, job.orgId, job.jobId, {
    state: 'ready',
    count: sheets.length,
    at: ctx.clock.now(),
  });
  ctx.log.info('prints.bulk_done', { orgId: job.orgId, count: sheets.length, engine });
}
