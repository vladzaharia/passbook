import type { PassJson } from '../../../passkit/types.ts';
import type { Grant } from '../../platform/authority.ts';
import { AppError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { credentialTombstoneRef } from '../passes/credential-tombstones.ts';
import { newScanCode, primaryBarcodeMessage } from '../passes/scan-code.ts';
import { readSystemValue } from '../settings/repo.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { lookupHashOf } from './codes.ts';
import { scanCredentialKeys } from './credential-input.ts';
import { recoverScans } from './recover.ts';
import { pruneExpiredScanAssetGrants } from './repo-asset-grants.ts';
import {
  type BackfillKeys,
  type BackfillRow,
  backfillBlockedByTransfer,
  backfillCandidates,
  backfillGrant,
  commitBackfill,
  completeBackfill,
  FRESH_STATE,
  parseBackfillState,
  saveBackfillState,
} from './repo-lookup-backfill.ts';
import { deleteScansBefore, pendingScans } from './repo-scans.ts';

const DAY = 86_400_000;
const RECONCILE_AFTER_MS = 60_000;
const RECONCILE_BATCH = 100;
const BACKFILL_BATCH = 200;
export const BACKFILL_DONE = 'scan.backfillDone';
const BACKFILL_STATE = 'scan.backfillCursor';
const BACKFILL_MAX_SWEEPS = 5;

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
 * run, walking the passes by id. A row that cannot be filled is logged and passed over, so it never
 * starves the rows behind it. Stops for good once a sweep from the start finds nothing to write
 * and nothing failed (system setting `scan.backfillDone`).
 */
export async function backfillScanLookups(ctx: ServiceContext): Promise<void> {
  // Capture the effective KEK set before the first await and use it for the whole batch.
  const credentialEnv = { ...ctx.env };
  const db = credentialEnv.DB;
  if ((await readSystemValue(db, BACKFILL_DONE)) === true) return;
  const keyset = await ensureCredentialRefKeyset(db, credentialEnv);
  let state = parseBackfillState(await readSystemValue(db, BACKFILL_STATE));
  let rows = await backfillCandidates(db, state.after, BACKFILL_BATCH);
  if (rows.length === 0 && state.after !== null) {
    // The sweep reached the end. Writes or failures mean rows may have been missed: sweep again.
    if ((state.wrote > 0 || state.failed > 0) && state.sweeps < BACKFILL_MAX_SWEEPS) {
      state = { after: null, wrote: 0, failed: 0, sweeps: state.sweeps + 1 };
      rows = await backfillCandidates(db, null, BACKFILL_BATCH);
    } else if (state.failed > 0)
      ctx.log.warn('scan.backfill_unfinished', {
        code: 'SCAN_BACKFILL_UNFINISHED',
        sweeps: state.sweeps,
      });
  }
  if (rows.length === 0) {
    if (await backfillBlockedByTransfer(db)) {
      ctx.log.info('scan.backfill_waiting', { code: 'SCAN_BACKFILL_TRANSFER_PENDING' });
      await saveBackfillState(ctx, BACKFILL_STATE, FRESH_STATE);
      return;
    }
    if (await completeBackfill(ctx, BACKFILL_DONE, BACKFILL_STATE))
      ctx.log.info('scan.backfill_done', {});
    else await saveBackfillState(ctx, BACKFILL_STATE, FRESH_STATE);
    return;
  }
  const prepared: Prepared[] = [];
  let skipped = 0;
  for (const row of rows) {
    const derived = await deriveKeys(ctx, credentialEnv, keyset, row);
    if (!derived) {
      skipped++;
      continue;
    }
    prepared.push({ id: row.id, make: () => backfillGrant(ctx, row, derived.keys, derived.refs) });
  }
  const failed = await commitAll(ctx, db, prepared);
  const last = rows.at(-1);
  state = {
    after: last ? last.id : state.after,
    wrote: state.wrote + prepared.length - failed,
    failed: state.failed + failed,
    sweeps: state.sweeps,
  };
  await saveBackfillState(ctx, BACKFILL_STATE, state);
  ctx.log.info('scan.backfill', { passes: rows.length, skipped, failed });
}

type Derived = { keys: BackfillKeys; refs: string[] };
type Prepared = { id: string; make: () => Grant | null };

/** Compute the missing keys of one row, or log why it yields none. Malformed JSON only costs its hashes. */
async function deriveKeys(
  ctx: ServiceContext,
  credentialEnv: ServiceContext['env'],
  keyset: string,
  row: BackfillRow,
): Promise<Derived | null> {
  let message: string | null = null;
  let typed: unknown;
  try {
    message = row.passJson ? primaryBarcodeMessage(JSON.parse(row.passJson) as PassJson) : null;
  } catch {
    ctx.log.warn('scan.backfill_skip', { code: 'SCAN_BACKFILL_MALFORMED_PASS', passId: row.id });
  }
  try {
    typed = row.lookupInput
      ? (JSON.parse(row.personalization) as Record<string, unknown>)[row.lookupInput]
      : undefined;
  } catch {
    ctx.log.warn('scan.backfill_skip', {
      code: 'SCAN_BACKFILL_MALFORMED_PERSONALIZATION',
      passId: row.id,
    });
  }
  const typedValue = typeof typed === 'string' || typeof typed === 'number' ? String(typed) : null;
  const scanCode = row.scanCode === null ? newScanCode(ctx) : null;
  const [messageDigest, lookupHash, represented] = await Promise.all([
    message ? sha256Hex(message) : Promise.resolve(null),
    row.lookupHash === null && typedValue !== null
      ? lookupHashOf(typedValue)
      : Promise.resolve(null),
    Promise.all(
      [row.serial, row.scanCode, scanCode, message, typedValue]
        .filter((value): value is string => value !== null)
        .map((value) =>
          scanCredentialKeys(credentialEnv, row.orgId, row.mode, value, false, undefined, keyset),
        ),
    ),
  ]);
  const barcodeHash = row.barcodeHash === null && row.removedAt === null ? messageDigest : null;
  if (scanCode === null && barcodeHash === null && lookupHash === null) {
    ctx.log.warn('scan.backfill_skip', { code: 'SCAN_BACKFILL_NOTHING_TO_WRITE', passId: row.id });
    return null;
  }
  const digests = [
    ...new Set(
      [row.barcodeHash, row.lookupHash, messageDigest, lookupHash].filter(
        (value): value is string => value !== null,
      ),
    ),
  ];
  const directRefs = await Promise.all(
    digests.map((digest) => credentialTombstoneRef(credentialEnv, row.orgId, row.mode, digest)),
  );
  const refs = [
    ...new Set([...directRefs, ...represented.flatMap((entry) => entry.credentialTombstoneRefs)]),
  ];
  return { keys: { scanCode, barcodeHash, lookupHash }, refs };
}

const CHUNK = 25;

/** A grant refusal (stale row, moved credential, suspended org) is a skip; anything else is a bug. */
const refusal = (error: unknown) => error instanceof AppError && error.status < 500;

/** Commit in batches; a refused batch is retried one grant at a time. Returns how many were refused. */
async function commitAll(
  ctx: ServiceContext,
  db: D1Database,
  prepared: Prepared[],
): Promise<number> {
  let refused = 0;
  for (let start = 0; start < prepared.length; start += CHUNK) {
    const chunk = prepared.slice(start, start + CHUNK);
    try {
      await commitBackfill(
        db,
        chunk.map((entry) => entry.make()).filter((g): g is Grant => g !== null),
      );
      continue;
    } catch (error) {
      if (!refusal(error)) throw error;
    }
    for (const entry of chunk) {
      const g = entry.make();
      if (!g) {
        refused++;
        continue;
      }
      try {
        await g.commit();
      } catch (error) {
        if (!refusal(error)) throw error;
        refused++;
        ctx.log.warn('scan.backfill_skip', {
          code: 'SCAN_BACKFILL_REFUSED',
          passId: entry.id,
        });
      }
    }
  }
  return refused;
}

/** Daily: expire asset grants and purge scans according to live and sandbox retention. */
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
  await pruneExpiredScanAssetGrants(ctx.env.DB, now);
  ctx.log.info('scan.retention', { live, test });
}
