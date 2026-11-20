import type { JobOf } from '../../jobs/types.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { readStoredBulk, writeBulkStatus } from './bulk-status.ts';
import { printPageModel } from './page.ts';
import { type ImageCache, loadImages, logImageProblem } from './pdf-images.ts';
import { type PrintSheet, renderPdf } from './pdf-render.ts';
import { sheetOf } from './pdf-service.ts';
import { bulkKey, putPdf } from './pdf-store.ts';
import { activePrintIds } from './repo.ts';

/**
 * Renders the combined PDF of a bulk Print, one page per ticket. A pass whose print ended
 * meanwhile is left out and counted as skipped (a PDF made before such a void is removed by the drop hooks and sweep).
 */
export async function handlePrintsBulk(job: JobOf<'prints.bulk'>, ctx: ServiceContext) {
  const bucket = ctx.env.BUCKET;
  const stored = await readStoredBulk(bucket, job.orgId, job.jobId);
  if (stored?.state !== 'pending') return;
  const sheets: PrintSheet[] = [];
  const printIds: string[] = [];
  const imageCache: ImageCache = new Map();
  let skipped = 0;
  const skip = (passId: string, code: string) => {
    skipped++;
    ctx.log.warn('prints.bulk_pass_skipped', {
      code: 'PRINT_BULK_PASS_SKIPPED',
      reason: code,
      passId,
    });
  };
  for (const passId of job.passIds) {
    const pass = await getPass(ctx.env.DB, passId, job.orgId);
    if (!pass) {
      skip(passId, 'PASS_NOT_FOUND');
      continue;
    }
    try {
      const model = await printPageModel(ctx, pass, 'staff');
      if (model.state === 'ready') {
        sheets.push({
          ...sheetOf(model),
          images: await loadImages(ctx, pass, model.files, imageCache),
        });
        printIds.push(model.printId);
      } else skip(passId, `PRINT_${model.state.toUpperCase()}`);
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error;
      skip(passId, error.code);
    }
  }
  const done = { ...stored, skipped };
  if (sheets.length === 0) {
    await writeBulkStatus(bucket, job.orgId, job.jobId, {
      ...done,
      state: 'failed',
      count: 0,
      at: ctx.clock.now(),
    });
    return;
  }
  let lossy = false;
  const bytes = await renderPdf(sheets, {
    assets: ctx.env.ASSETS,
    onLossy: () => {
      lossy = true;
      ctx.log.warn('prints.pdf_lossy_text', { code: 'PRINT_PDF_TEXT_LOSSY' });
    },
    onImageError: logImageProblem(ctx),
  });
  const key = bulkKey(job.orgId, job.jobId, 'pdf');
  await putPdf(bucket, key, bytes);
  // A print voided while this rendered must not leave its code in a PDF the drop hooks never saw.
  const active = await activePrintIds(ctx.env.DB, printIds);
  if (printIds.some((id) => !active.has(id))) {
    await bucket.delete(key);
    ctx.log.warn('prints.bulk_voided_mid_render', { code: 'PRINT_BULK_VOIDED_MID_RENDER' });
    await writeBulkStatus(bucket, job.orgId, job.jobId, {
      ...done,
      state: 'failed',
      count: 0,
      at: ctx.clock.now(),
    });
    return;
  }
  await writeBulkStatus(bucket, job.orgId, job.jobId, {
    ...done,
    state: 'ready',
    count: sheets.length,
    engine: 'pdf-lib',
    lossy,
    at: ctx.clock.now(),
  });
  ctx.log.info('prints.bulk_done', { orgId: job.orgId, count: sheets.length, skipped });
}
