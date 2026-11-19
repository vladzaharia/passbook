import type { ServiceContext } from '../../platform/service-context.ts';
import { activePrintIds } from './repo.ts';

const DAY = 86_400_000;
const PAGES = 20;
const IN_LIMIT = 90;
/** A bulk PDF and its status stay this long for the download. */
const BULK_KEEP_MS = 7 * DAY;
const KEY = /^prints\/[^/]+\/([^/]+)\/([^/]+)\.pdf$/;

/**
 * Daily: deletes PDFs whose print is no longer active (a void, holder change, New code or a purge
 * the inline hooks missed) and bulk PDFs after a week. Reads at most PAGES x 1,000 keys a run.
 */
export async function sweepPrintPdfs(ctx: ServiceContext): Promise<void> {
  const bucket = ctx.env.BUCKET;
  const before = ctx.clock.now() - BULK_KEEP_MS;
  const stale: string[] = [];
  const perPrint: { key: string; printId: string }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PAGES; page++) {
    const listed = await bucket.list({ prefix: 'prints/', ...(cursor ? { cursor } : {}) });
    for (const o of listed.objects) {
      const m = KEY.exec(o.key);
      if (m?.[1] && m[1] !== 'bulk' && m[2]) perPrint.push({ key: o.key, printId: m[2] });
      else if (o.uploaded.getTime() < before) stale.push(o.key);
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  for (let i = 0; i < perPrint.length; i += IN_LIMIT) {
    const part = perPrint.slice(i, i + IN_LIMIT);
    const active = await activePrintIds(
      ctx.env.DB,
      part.map((p) => p.printId),
    );
    for (const p of part) if (!active.has(p.printId)) stale.push(p.key);
  }
  for (let i = 0; i < stale.length; i += 1000) await bucket.delete(stale.slice(i, i + 1000));
  ctx.log.info('prints.pdf_sweep', { deleted: stale.length });
}
