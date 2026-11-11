import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanOutcome, ScanRecordDto } from '../../../shared/contracts/index.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import { bump, read } from '../../platform/counters.ts';
import { batch } from '../../platform/db.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { decodeConsoleCursor, encodeConsoleCursor } from './console-cursor.ts';
import { captureCredentialKeyset, credentialKeysetContext } from './credential-keyset-authority.ts';
import { currentApiFeedSelection } from './feed-api-page.ts';
import {
  assertConsoleAuthority,
  captureConsoleFeed,
  EXPORT_PAGE,
  type RecordCache,
  recordPage,
} from './feed-console-page.ts';
import { csvRow, EXPORT_COLUMNS, exportCells } from './feed-csv.ts';
import {
  assertFeedKey,
  type ConsoleAuthority,
  consoleFeedAuthorityPredicate,
  type Feed,
  fenceRecords,
  recordsOf,
  toFeed,
} from './feed-projection.ts';
import { createFeedProofCache, verifyRows } from './feed-proof.ts';
import {
  apiKeyFeedGuard,
  countScanRows,
  getApiKeyFeedStatus,
  getScanForUndo,
  getScanRow,
  listScanRows,
  type ScanLogFilter,
  type ScanLogRow,
  scanExportAuditStmt,
} from './repo-feed.ts';

const DAY = 86_400_000;
export const UNDO_MAX_MS = 30 * DAY;
export const EXPORT_MAX_RANGE_MS = 92 * DAY;
export const EXPORT_MAX_ROWS = 100_000;
export const EXPORTS_PER_HOUR = 10;

export interface ConsoleUndoInput {
  scanId: string;
  orgId: string;
  mode: Mode;
  idempotencyKey: string;
  maxAgeMs: number;
}

/** SV.6's undo service, run as an admin. */
export type ConsoleUndo = (
  ctx: ServiceContext,
  session: SessionAuth,
  input: ConsoleUndoInput,
) => Promise<ScanOutcome>;

export async function listScanRecords(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: ConsoleAuthority,
  filter: ScanLogFilter,
) {
  ctx = credentialKeysetContext(ctx);
  const { actor, credentialKeysetCommitment } = await captureConsoleFeed(ctx, session, authority);
  return recordPage(ctx, session, authority, filter, {
    actor,
    proofs: createFeedProofCache(credentialKeysetCommitment),
    operation: 'list',
  });
}

export async function listScanFeed(ctx: ServiceContext, auth: ApiKeyAuth, filter: ScanLogFilter) {
  ctx = credentialKeysetContext(ctx);
  if (auth.orgId && filter.orgId && auth.orgId !== filter.orgId) throw new ForbiddenError();
  const now = ctx.clock.now();
  const scoped = { ...filter, orgId: auth.orgId ?? filter.orgId, mode: auth.mode };
  const scope = {
    auth,
    orgId: scoped.orgId,
    mode: scoped.mode,
    filters: scoped,
    operation: 'list' as const,
  };
  if (scoped.staffId) {
    if (scoped.cursor !== undefined) await decodeConsoleCursor(ctx, scope, scoped.cursor);
    assertFeedKey(await getApiKeyFeedStatus(ctx.env.DB, auth, scoped, ctx.clock.now()));
    return { items: [], nextCursor: null };
  }
  const credentialKeysetCommitment = await captureCredentialKeyset(ctx, apiKeyFeedGuard(auth, now));
  if (!credentialKeysetCommitment) {
    assertFeedKey(await getApiKeyFeedStatus(ctx.env.DB, auth, scoped, ctx.clock.now()));
    throw new ForbiddenError();
  }
  const proofs = createFeedProofCache(credentialKeysetCommitment);
  // No raw row id is accepted as a continuation, including for the staff-hidden fast path.
  const position =
    scoped.cursor !== undefined ? await decodeConsoleCursor(ctx, scope, scoped.cursor) : undefined;
  const base = {
    ...scoped,
    passId: undefined,
    q: undefined,
    staffId: undefined,
    cursor: undefined,
    internalCursor: undefined,
  };
  const size = Math.min(Math.max(filter.limit + 1, 50), EXPORT_PAGE);
  const rows = await listScanRows(ctx.env.DB, {
    ...base,
    internalCursor: position,
    now,
    limit: size,
  });
  const verified = await verifyRows(ctx, rows, proofs);
  const pageOf = (selection: { selected: readonly ScanLogRow[]; allowed: ReadonlySet<string> }) => {
    const byId = new Map(selection.selected.map((row) => [row.id, row]));
    const visible: Feed[] = [];
    for (const row of rows) {
      const authorized = selection.allowed.has(row.id) ? byId.get(row.id) : undefined;
      if (!authorized) continue;
      const item = toFeed(authorized);
      if (
        (!filter.passId || item.passId === filter.passId) &&
        (!filter.eventId || item.eventId === filter.eventId) &&
        (!filter.scannerId || item.scannerId === filter.scannerId) &&
        (!filter.q || item.passId === filter.q)
      )
        visible.push(item);
    }
    const items = visible.slice(0, filter.limit);
    const overflow = visible.length > filter.limit;
    const boundary = overflow ? items.at(-1) : rows.at(-1);
    return { items, boundary: boundary && (overflow || rows.length === size) ? boundary : null };
  };
  const current = await currentApiFeedSelection(
    ctx,
    auth,
    base,
    verified.rows,
    verified.passless,
    credentialKeysetCommitment,
  );
  const page = pageOf(current);
  const boundary = page.boundary;
  if (!boundary) return { items: page.items, nextCursor: null };
  const nextCursor = await encodeConsoleCursor(ctx, scope, {
    at: boundary.at,
    id: boundary.id,
  });
  const boundaryRow = rows.find((row) => row.id === boundary.id && row.at === boundary.at);
  if (!boundaryRow)
    throw new ConflictError('Scan history changed. Reload and retry.', 'SCAN_HISTORY_CHANGED');
  const final = pageOf(
    await currentApiFeedSelection(
      ctx,
      auth,
      base,
      current.selected,
      verified.passless,
      credentialKeysetCommitment,
      boundaryRow,
    ),
  );
  if (final.boundary && (final.boundary.id !== boundary.id || final.boundary.at !== boundary.at))
    throw new ConflictError('Scan history changed. Reload and retry.', 'SCAN_HISTORY_CHANGED');
  return { items: final.items, nextCursor: final.boundary ? nextCursor : null };
}

/** Undo delegates its authority checks and needs no pass-derived log fields. */
export async function loadUndoRow(ctx: ServiceContext, id: string) {
  const row = await getScanForUndo(ctx.env.DB, id);
  if (!row) throw new NotFoundError('Scan not found.', 'SCAN_NOT_FOUND');
  return row;
}

export async function scanRecord(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: ConsoleAuthority,
  id: string,
): Promise<ScanRecordDto> {
  ctx = credentialKeysetContext(ctx);
  const { actor, credentialKeysetCommitment } = await captureConsoleFeed(ctx, session, authority);
  const proofs = createFeedProofCache(credentialKeysetCommitment);
  const row = await getScanRow(ctx.env.DB, id, ctx.clock.now(), authority.mode);
  if (!row || row.orgId !== authority.orgId)
    throw new NotFoundError('Scan not found.', 'SCAN_NOT_FOUND');
  const verified = await verifyRows(ctx, [row], proofs);
  const records = await recordsOf(
    ctx,
    session,
    authority,
    credentialKeysetCommitment,
    verified.rows,
    proofs.events,
    verified.passless,
    actor,
  );
  let record: ScanRecordDto | undefined;
  try {
    record = (await fenceRecords(ctx, credentialKeysetCommitment, records, actor))[0]?.record;
  } catch (error) {
    if (error instanceof ForbiddenError)
      throw new NotFoundError('Scan not found.', 'SCAN_NOT_FOUND');
    throw error;
  }
  if (!record) throw new NotFoundError('Scan not found.', 'SCAN_NOT_FOUND');
  return record;
}

export interface ExportRequest {
  orgId: string;
  from: number;
  to: number;
  filter: Omit<ScanLogFilter, 'mode' | 'orgId' | 'from' | 'to' | 'cursor' | 'limit' | 'now'>;
}

/**
 * Checks the limits, counts the export against the user's hourly cap, audits it, and returns the CSV
 * as a stream of pages, retaining only proof verification results across pages.
 */
export async function exportScans(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: ConsoleAuthority,
  req: ExportRequest,
): Promise<{ name: string; body: ReadableStream<Uint8Array> }> {
  ctx = credentialKeysetContext(ctx);
  if (req.to <= req.from || req.to - req.from > EXPORT_MAX_RANGE_MS)
    throw new ValidationError('Export up to 92 days at a time.', [], 'SCAN_EXPORT_RANGE');
  const { actor, credentialKeysetCommitment } = await captureConsoleFeed(ctx, session, authority);
  const now = ctx.clock.now();
  const filter: ScanLogFilter = {
    ...req.filter,
    mode: authority.mode,
    orgId: authority.orgId,
    from: req.from,
    to: req.to,
    limit: EXPORT_PAGE,
    now,
  };
  const cache: RecordCache = {
    actor,
    proofs: createFeedProofCache(credentialKeysetCommitment),
    operation: 'export',
  };
  const exportKey = `scan:export:${session.userId}`;
  const hour = now - (now % 3_600_000);
  const limited = () => new RateLimitedError(Math.ceil((hour + 3_600_000 - now) / 1000));
  // Read first so a user over the cap costs no scan; count the export only once it will run.
  if ((await read(ctx.env.DB, exportKey, hour)) >= EXPORTS_PER_HOUR) throw limited();
  let rows = 0;
  if (filter.q || filter.passId || filter.eventId || filter.scannerId || filter.staffId) {
    let cursor: string | undefined;
    do {
      const page = await recordPage(ctx, session, authority, { ...filter, cursor }, cache);
      rows += page.items.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor && rows <= EXPORT_MAX_ROWS);
  } else {
    rows = await countScanRows(ctx.env.DB, filter, EXPORT_MAX_ROWS);
  }
  await assertConsoleAuthority(ctx, actor, credentialKeysetCommitment);
  if (rows > EXPORT_MAX_ROWS)
    throw new ValidationError('Export up to 100,000 scans at a time.', [], 'SCAN_EXPORT_TOO_LARGE');
  if ((await bump(ctx.env.DB, exportKey, hour)) > EXPORTS_PER_HOUR) throw limited();
  const [audit] = await batch(ctx.env.DB, [
    scanExportAuditStmt(
      ctx.env.DB,
      ctx,
      authority,
      { from: req.from, to: req.to, rows },
      credentialKeysetCommitment,
      await consoleFeedAuthorityPredicate(ctx, actor),
    ),
  ]);
  await assertConsoleAuthority(ctx, actor, credentialKeysetCommitment);
  if (audit?.meta.changes !== 1) throw new ForbiddenError();
  const encoder = new TextEncoder();
  let cursor: string | undefined;
  let started = false;
  const stamp = (at: number) => new Date(at).toISOString().slice(0, 10);
  return {
    name: `scans-${stamp(req.from)}-${stamp(req.to)}.csv`,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started) {
          await assertConsoleAuthority(ctx, actor, credentialKeysetCommitment);
          started = true;
          controller.enqueue(encoder.encode(`﻿${csvRow(EXPORT_COLUMNS)}`));
          return;
        }
        for (;;) {
          const page = await recordPage(ctx, session, authority, { ...filter, cursor }, cache);
          cursor = page.nextCursor ?? undefined;
          if (page.items.length) {
            controller.enqueue(
              encoder.encode(page.items.map((row) => csvRow(exportCells(row))).join('')),
            );
            if (!cursor) controller.close();
            return;
          }
          if (!cursor) return controller.close();
        }
      },
    }),
  };
}
