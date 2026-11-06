import type { PassJson } from '../../../passkit/types.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { newScanCode, primaryBarcodeMessage } from '../passes/scan-code.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { lookupHashOf } from './codes.ts';
import { recoverScans } from './recover.ts';
import { backfillCandidates, writeKeysStmt } from './repo-lookup.ts';
import { deleteScansBefore, pendingScans } from './repo-scans.ts';

const DAY = 86_400_000;
const RECONCILE_AFTER_MS = 60_000;
const RECONCILE_BATCH = 100;
const BACKFILL_BATCH = 200;
export const BACKFILL_DONE = 'scan.backfillDone';

/** Minute: settles pending scans older than 60 s (SA 9.3), 100 rows a run. */
export async function reconcileScans(ctx: ServiceContext): Promise<void> {
  const rows = await pendingScans(
    ctx.env.DB,
    ctx.clock.now() - RECONCILE_AFTER_MS,
    RECONCILE_BATCH,
  );
  if (rows.length === 0) return;
  const { finished, failed } = await recoverScans(ctx, rows);
  ctx.log.info('scan.reconcile', { finished, failed });
}

/**
 * Minute: fills `scan_code`, `barcode_hash` and `lookup_hash` on passes that predate them, 200 a
 * run. Stops for good once a run finds nothing (system setting `scan.backfillDone`).
 */
export async function backfillScanLookups(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  if ((await readSystemValue(db, BACKFILL_DONE)) === true) return;
  const rows = await backfillCandidates(db, BACKFILL_BATCH);
  if (rows.length === 0) {
    await writeSystemValue(db, BACKFILL_DONE, true, ctx.clock.now());
    ctx.log.info('scan.backfill_done', {});
    return;
  }
  const statements: D1PreparedStatement[] = [];
  for (const row of rows) {
    const message = row.passJson
      ? primaryBarcodeMessage(JSON.parse(row.passJson) as PassJson)
      : null;
    const typed = row.lookupInput
      ? (JSON.parse(row.personalization) as Record<string, unknown>)[row.lookupInput]
      : undefined;
    statements.push(
      writeKeysStmt(db, row.id, {
        scanCode: row.scanCode === null ? newScanCode(ctx) : null,
        barcodeHash:
          row.barcodeHash === null && row.removedAt === null && message
            ? await sha256Hex(message)
            : null,
        lookupHash:
          row.lookupHash === null && (typeof typed === 'string' || typeof typed === 'number')
            ? await lookupHashOf(String(typed))
            : null,
      }),
    );
  }
  await db.batch(statements);
  ctx.log.info('scan.backfill', { passes: rows.length });
}

/** Daily: live scans past `retention.scansDays`, test scans past `sandbox.purgeDays`. */
export async function dailyScans(ctx: ServiceContext): Promise<void> {
  const settings = await getPlatformSettings(ctx);
  const now = ctx.clock.now();
  const live = await deleteScansBefore(
    ctx.env.DB,
    'live',
    now - settings['retention.scansDays'] * DAY,
  );
  const test = await deleteScansBefore(
    ctx.env.DB,
    'test',
    now - settings['sandbox.purgeDays'] * DAY,
  );
  ctx.log.info('scan.retention', { live, test });
}
