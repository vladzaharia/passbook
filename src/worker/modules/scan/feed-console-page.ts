import type { SessionAuth } from '../../platform/auth.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { decodeConsoleCursor, encodeConsoleCursor } from './console-cursor.ts';
import {
  type ConsoleAuthority,
  consoleFeedActor,
  recordMatches,
  recordsOf,
} from './feed-projection.ts';
import type { ScanActor } from './guard.ts';
import type { HistoryEvidenceCache } from './history-row-evidence.ts';
import { listScanRows, type ScanLogFilter } from './repo-feed.ts';
import { scanAuthorizedStmt, scanReadAuthority } from './repo-read-authority.ts';

export const EXPORT_PAGE = 1000;

export interface RecordCache {
  actor: ScanActor;
  evidence: HistoryEvidenceCache;
  operation: 'list' | 'export';
}

/** Capture one session incarnation with its epochs for the whole list, detail or export. */
export async function captureConsoleFeed(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: ConsoleAuthority,
): Promise<ScanActor> {
  const actor = await consoleFeedActor(ctx, session, authority);
  await captureScanEpochs(ctx.env.DB, actor);
  return actor;
}

/** The read fence at the request clock: the same membership, session and org checks as a write. */
export const consoleReadAuthority = (ctx: ServiceContext, actor: ScanActor) =>
  scanReadAuthority(actor, { now: ctx.clock.now() });

/** A streamed page must not outlive the session which authorized it. */
export async function assertConsoleAuthority(ctx: ServiceContext, actor: ScanActor) {
  const row = await scanAuthorizedStmt(ctx.env.DB, consoleReadAuthority(ctx, actor)).first<{
    authorized: number;
  }>();
  if (row?.authorized !== 1) throw new ForbiddenError();
}

/** Match pass IDs and titles only after projection, never against hidden or cached data. */
export async function recordPage(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: ConsoleAuthority,
  filter: ScanLogFilter,
  cache: RecordCache,
) {
  const now = filter.now ?? ctx.clock.now();
  const scope = {
    auth: session,
    orgId: authority.orgId,
    mode: authority.mode,
    filters: filter,
    operation: cache.operation,
  };
  const position =
    filter.cursor !== undefined ? await decodeConsoleCursor(ctx, scope, filter.cursor) : undefined;
  const size = Math.min(Math.max(filter.limit + 1, 50), EXPORT_PAGE);
  // Pass and title filters depend on the projection; event, scanner and staff filters run in SQL.
  const candidatesFilter: ScanLogFilter = {
    ...filter,
    orgId: authority.orgId,
    mode: authority.mode,
    passId: undefined,
    q: undefined,
    cursor: undefined,
    internalCursor: position,
    limit: size,
    now,
  };
  const { authorized, rows } = await listScanRows(
    ctx.env.DB,
    consoleReadAuthority(ctx, cache.actor),
    candidatesFilter,
    // Each page judges Wallet validity by the clock it reads at: a pass that expires during a long
    // export stops being exported. The filter's `now` stays the export's, for its cursor scope.
    ctx.clock.now(),
  );
  if (!authorized) throw new ForbiddenError();
  const projected = await recordsOf(ctx, rows, cache.actor, cache.evidence);
  const searched = !!(filter.q || filter.passId);
  const visible = projected
    .filter((item) => !searched || (item.row.policyAvailable && item.row.passId !== null))
    .map((item) => item.record)
    .filter((record) => recordMatches(record, filter));
  const items = visible.slice(0, filter.limit);
  const overflow = visible.length > filter.limit;
  const boundary = overflow ? items.at(-1) : rows.at(-1);
  if (!boundary || !(overflow || rows.length === size)) return { items, nextCursor: null };
  return {
    items,
    nextCursor: await encodeConsoleCursor(ctx, scope, { at: boundary.at, id: boundary.id }),
  };
}
