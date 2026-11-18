import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanOutcome, ScanRecordDto } from '../../../shared/contracts/index.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import { bump, read } from '../../platform/counters.ts';
import {
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { decodeConsoleCursor, encodeConsoleCursor } from './console-cursor.ts';
import { doorHistories } from './feed-api-door.ts';
import {
  assertConsoleAuthority,
  captureConsoleFeed,
  consoleReadAuthority,
  EXPORT_PAGE,
  type RecordCache,
  recordPage,
} from './feed-console-page.ts';
import { csvRow, exportCells, exportColumns } from './feed-csv.ts';
import {
  assertFeedKey,
  type ConsoleAuthority,
  type Feed,
  recordsOf,
  toFeed,
} from './feed-projection.ts';
import { checkProvenance, createHistoryEvidenceCache, withKeyset } from './history-row-evidence.ts';
import {
  auditScanExport,
  countScanRows,
  getApiKeyFeedStatus,
  getScanForUndo,
  getScanRow,
  listScanRows,
  type ScanLogFilter,
} from './repo-feed.ts';
import { apiKeyReadAuthority } from './repo-read-authority.ts';

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
  const actor = await captureConsoleFeed(ctx, session, authority);
  return recordPage(ctx, session, authority, filter, {
    actor,
    evidence: createHistoryEvidenceCache(),
    operation: 'list',
  });
}

export async function listScanFeed(ctx: ServiceContext, auth: ApiKeyAuth, filter: ScanLogFilter) {
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
  const refused = async () => {
    assertFeedKey(await getApiKeyFeedStatus(ctx.env.DB, auth, scoped, now));
  };
  // No raw row id is accepted as a continuation, including for the staff-hidden fast path.
  const position =
    scoped.cursor !== undefined ? await decodeConsoleCursor(ctx, scope, scoped.cursor) : undefined;
  if (scoped.staffId) {
    await refused();
    return { items: [], nextCursor: null };
  }
  const size = Math.min(Math.max(filter.limit + 1, 50), EXPORT_PAGE);
  const { authorized, rows } = await listScanRows(
    ctx.env.DB,
    apiKeyReadAuthority(auth, scoped.orgId, now),
    {
      ...scoped,
      passId: undefined,
      q: undefined,
      staffId: undefined,
      cursor: undefined,
      internalCursor: position,
      now,
      limit: size,
    },
    now,
  );
  if (!authorized) {
    await refused();
    throw new ForbiddenError();
  }
  const cache = createHistoryEvidenceCache();
  const { checked, door } = await withKeyset(ctx, rows, async () => {
    const marked = await checkProvenance(ctx, rows, cache);
    return { checked: marked, door: await doorHistories(ctx, marked, cache) };
  });
  const visible: Feed[] = [];
  for (const row of checked) {
    const item = toFeed(row, door.get(row.id) ?? null);
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
  if (!boundary || !(overflow || rows.length === size)) return { items, nextCursor: null };
  return {
    items,
    nextCursor: await encodeConsoleCursor(ctx, scope, { at: boundary.at, id: boundary.id }),
  };
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
  const actor = await captureConsoleFeed(ctx, session, authority);
  const now = ctx.clock.now();
  const { authorized, rows } = await getScanRow(
    ctx.env.DB,
    consoleReadAuthority(ctx, actor),
    id,
    now,
  );
  const [projected] = authorized
    ? await recordsOf(ctx, rows, actor, createHistoryEvidenceCache())
    : [];
  if (!projected) throw new NotFoundError('Scan not found.', 'SCAN_NOT_FOUND');
  return projected.record;
}

export interface ExportRequest {
  orgId: string;
  from: number;
  to: number;
  /** Adds the local time column. */
  timeZone?: string;
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
  if (req.to <= req.from || req.to - req.from > EXPORT_MAX_RANGE_MS)
    throw new ValidationError('Export up to 92 days at a time.', [], 'SCAN_EXPORT_RANGE');
  const actor = await captureConsoleFeed(ctx, session, authority);
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
    evidence: createHistoryEvidenceCache(),
    operation: 'export',
  };
  const exportKey = `scan:export:${session.userId}`;
  const hour = now - (now % 3_600_000);
  const limited = () => new RateLimitedError(Math.ceil((hour + 3_600_000 - now) / 1000));
  // Read first so a user over the cap costs no scan; count the export only once it will run.
  if ((await read(ctx.env.DB, exportKey, hour)) >= EXPORTS_PER_HOUR) throw limited();
  // A pass or title search pages through unfiltered scans to count: it is charged before it runs,
  // so a request that never finishes counting still spends the hour's cap.
  const searched = !!(filter.q || filter.passId);
  if (searched && (await bump(ctx.env.DB, exportKey, hour)) > EXPORTS_PER_HOUR) throw limited();
  let rows = 0;
  if (searched || filter.eventId || filter.scannerId || filter.staffId) {
    let cursor: string | undefined;
    do {
      const page = await recordPage(ctx, session, authority, { ...filter, cursor }, cache);
      rows += page.items.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor && rows <= EXPORT_MAX_ROWS);
  } else {
    const counted = await countScanRows(
      ctx.env.DB,
      consoleReadAuthority(ctx, actor),
      filter,
      EXPORT_MAX_ROWS,
    );
    if (!counted.authorized) throw new ForbiddenError();
    rows = counted.n;
  }
  await assertConsoleAuthority(ctx, actor);
  if (rows > EXPORT_MAX_ROWS)
    throw new ValidationError('Export up to 100,000 scans at a time.', [], 'SCAN_EXPORT_TOO_LARGE');
  if (!searched && (await bump(ctx.env.DB, exportKey, hour)) > EXPORTS_PER_HOUR) throw limited();
  // Last before streaming: the grant re-checks session, membership and org, and the stream's first pull checks the console guard.
  await auditScanExport(ctx, authority, { from: req.from, to: req.to, rows });
  const encoder = new TextEncoder();
  let cursor: string | undefined;
  let started = false;
  const stamp = (at: number) => new Date(at).toISOString().slice(0, 10);
  return {
    name: `scans-${stamp(req.from)}-${stamp(req.to)}.csv`,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started) {
          await assertConsoleAuthority(ctx, actor);
          started = true;
          controller.enqueue(encoder.encode(`﻿${csvRow(exportColumns(req.timeZone))}`));
          return;
        }
        for (;;) {
          const page = await recordPage(ctx, session, authority, { ...filter, cursor }, cache);
          cursor = page.nextCursor ?? undefined;
          if (page.items.length) {
            controller.enqueue(
              encoder.encode(
                page.items.map((row) => csvRow(exportCells(row, req.timeZone))).join(''),
              ),
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
