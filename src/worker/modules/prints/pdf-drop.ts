import type { ServiceContext } from '../../platform/service-context.ts';
import { deleteBulkOfPass, deletePassPdfs, pdfKey } from './pdf-store.ts';

/**
 * Deletes a pass's PDFs (and any bulk PDF holding it) after a void, reprint, transfer or purge (one print, or all of the pass's).
 * Access already ended with the print row, so a failure is logged and the daily sweep retries it.
 */
export async function dropPrintPdfs(
  ctx: ServiceContext,
  pass: { orgId: string; id: string },
  printId?: string,
): Promise<void> {
  try {
    // A combined PDF holds this pass's code too, so it goes with it.
    await deleteBulkOfPass(ctx.env.BUCKET, pass.orgId, pass.id);
    if (printId)
      await ctx.env.BUCKET.delete([
        pdfKey(pass.orgId, pass.id, printId),
        pdfKey(pass.orgId, pass.id, printId, 'holder'),
      ]);
    else await deletePassPdfs(ctx.env.BUCKET, pass.orgId, pass.id);
  } catch (error) {
    ctx.log.error('prints.pdf_delete_failed', { code: 'PRINT_PDF_DELETE_FAILED', error });
  }
}
