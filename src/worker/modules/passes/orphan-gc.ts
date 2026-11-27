import type { ServiceContext } from '../../platform/service-context.ts';
import { deletableVoidedCopies, referencedObjectKeys } from './repo-orphan-gc.ts';

/** Where the next run starts: outside `passes/`, so the sweep never lists it. */
const CURSOR_KEY = 'sweep/pass-objects-cursor';
const PAGES = 4;
const PAGE_SIZE = 500;
/** A put not yet committed to a row (publish, create, transfer) is never older than this. */
export const PASS_OBJECT_GRACE_MS = 24 * 60 * 60_000;
const KEY = /^passes\/([^/]+)\/v(\d+)-([^/]+?)(?:\.pkpass|\.preview\.json)$/;

/**
 * Daily: deletes pass objects (`passes/<id>/v<n>-<token>`) that no row points at, once they are past the
 * in-flight grace. The retention purge already deletes the objects of purged versions; this catches puts
 * whose commit never landed. Current heads, retained versions, boundary artifacts and anything recent stay.
 * Reads at most PAGES x PAGE_SIZE keys a run and keeps its list cursor in R2, so the next run continues.
 */
export async function sweepPassObjects(ctx: ServiceContext, pages = PAGES): Promise<void> {
  const bucket = ctx.env.BUCKET;
  const before = ctx.clock.now() - PASS_OBJECT_GRACE_MS;
  let cursor = (await (await bucket.get(CURSOR_KEY))?.text()) || undefined;
  let scanned = 0;
  let deleted = 0;
  for (let page = 0; page < pages; page++) {
    const listed = await bucket.list({
      prefix: 'passes/',
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const aged: { key: string; passId: string; version: number; voided: boolean }[] = [];
    for (const o of listed.objects) {
      scanned += 1;
      const m = KEY.exec(o.key);
      if (!m || o.uploaded.getTime() >= before) continue;
      aged.push({
        key: o.key,
        passId: m[1] ?? '',
        version: Number(m[2]),
        voided: m[3] === 'voided',
      });
    }
    const files = aged.filter((a) => !a.voided);
    const referenced = await referencedObjectKeys(
      ctx.env.DB,
      files.map((f) => f.key),
    );
    const voided = aged.filter((a) => a.voided);
    const stale = await deletableVoidedCopies(ctx.env.DB, voided);
    const doomed = [
      ...files.filter((f) => !referenced.has(f.key)),
      ...voided.filter((v) => stale.has(`${v.passId}/${v.version}`)),
    ].map((d) => d.key);
    if (doomed.length > 0) await bucket.delete(doomed);
    deleted += doomed.length;
    if (!listed.truncated) {
      cursor = undefined;
      break;
    }
    cursor = listed.cursor;
  }
  // A full pass starts over next time; a cut one carries on from where it stopped.
  if (cursor) await bucket.put(CURSOR_KEY, cursor);
  else await bucket.delete(CURSOR_KEY);
  ctx.log.info('passes.object_gc', { code: 'PASS_OBJECT_GC', scanned, deleted });
}
