import type { ServiceContext } from '../../platform/service-context.ts';
import { BULK_TTL_MS } from './bulk-status.ts';
import { activePrintIds } from './repo.ts';

const PAGES = 20;
const IN_LIMIT = 90;
/** Where the next run starts: outside `prints/`, so the sweep never lists it. */
const CURSOR_KEY = 'sweep/prints-cursor';
const KEY = /^prints\/[^/]+\/([^/]+)\/([^/.]+)(?:\.holder)?\.pdf$/;

/**
 * Daily: deletes PDFs whose print is no longer active (a void, holder change, New code or a purge
 * the inline hooks missed) and bulk PDFs after their 24 h. Reads at most PAGES x 1,000 keys a run and keeps its list cursor in R2, so the next run continues.
 */
export async function sweepPrintPdfs(ctx: ServiceContext, pages = PAGES): Promise<void> {
  const bucket = ctx.env.BUCKET;
  const before = ctx.clock.now() - BULK_TTL_MS;
  const stale: string[] = [];
  const perPrint: { key: string; printId: string }[] = [];
  let cursor = (await (await bucket.get(CURSOR_KEY))?.text()) || undefined;
  let more = false;
  for (let page = 0; page < pages; page++) {
    const listed = await bucket.list({ prefix: 'prints/', ...(cursor ? { cursor } : {}) });
    for (const o of listed.objects) {
      const m = KEY.exec(o.key);
      if (m?.[1] && m[1] !== 'bulk' && m[2]) perPrint.push({ key: o.key, printId: m[2] });
      else if (o.uploaded.getTime() < before) stale.push(o.key);
    }
    more = listed.truncated;
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  // A full pass starts over next time; a cut one carries on from where it stopped.
  if (more && cursor) await bucket.put(CURSOR_KEY, cursor);
  else await bucket.delete(CURSOR_KEY);
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
