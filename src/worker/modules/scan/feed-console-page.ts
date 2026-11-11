import type { SessionAuth } from '../../platform/auth.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { decodeConsoleCursor, encodeConsoleCursor } from './console-cursor.ts';
import { captureCredentialKeyset } from './credential-keyset-authority.ts';
import {
  type ConsoleAuthority,
  consoleFeedActor,
  consoleFeedAuthorityPredicate,
  fenceRecords,
  type ProjectedRecord,
  recordMatches,
  recordsOf,
} from './feed-projection.ts';
import { type FeedProofCache, verifyRows } from './feed-proof.ts';
import type { ScanActor } from './guard.ts';
import { consoleFeedAuthorityCurrent, listScanRows, type ScanLogFilter } from './repo-feed.ts';

export const EXPORT_PAGE = 1000;

export interface RecordCache {
  actor: ScanActor;
  proofs: FeedProofCache;
  operation: 'list' | 'export';
}

/** Capture one session incarnation and keyset for the whole list or export. */
export async function captureConsoleFeed(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: ConsoleAuthority,
) {
  const actor = await consoleFeedActor(ctx, session, authority);
  const credentialKeysetCommitment = await captureCredentialKeyset(
    ctx,
    await consoleFeedAuthorityPredicate(ctx, actor),
  );
  if (!credentialKeysetCommitment) throw new ForbiddenError();
  actor.credentialKeysetCommitment = credentialKeysetCommitment;
  return { actor, credentialKeysetCommitment };
}

/** A streamed page must not outlive the exact session and keyset which authorized it. */
export async function assertConsoleAuthority(
  ctx: ServiceContext,
  actor: ScanActor,
  credentialKeysetCommitment: string,
) {
  const guard = await consoleFeedAuthorityPredicate(ctx, actor);
  if (!(await consoleFeedAuthorityCurrent(ctx.env.DB, guard, credentialKeysetCommitment)))
    throw new ForbiddenError();
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
  const rows = await listScanRows(ctx.env.DB, candidatesFilter);
  const verified = await verifyRows(ctx, rows, cache.proofs);
  const candidates =
    filter.q || filter.passId
      ? verified.rows.filter((row) => row.policyAvailable && row.passId !== null)
      : verified.rows;
  const projected = await recordsOf(
    ctx,
    session,
    authority,
    cache.proofs.credentialKeysetCommitment,
    candidates,
    cache.proofs.events,
    verified.passless,
    cache.actor,
  );
  const matches = projected.filter((item) => recordMatches(item.record, filter));
  const current = await fenceRecords(
    ctx,
    cache.proofs.credentialKeysetCommitment,
    matches,
    cache.actor,
  );
  const pageOf = (values: readonly ProjectedRecord[]) => {
    const visible = values.map((item) => item.record).filter((item) => recordMatches(item, filter));
    const items = visible.slice(0, filter.limit);
    const overflow = visible.length > filter.limit;
    const boundary = overflow ? items.at(-1) : rows.at(-1);
    return { items, boundary: boundary && (overflow || rows.length === size) ? boundary : null };
  };
  const page = pageOf(current);
  const boundary = page.boundary;
  if (!boundary) return { items: page.items, nextCursor: null };
  const nextCursor = await encodeConsoleCursor(ctx, scope, {
    at: boundary.at,
    id: boundary.id,
  });
  // Encryption is asynchronous: recheck the exact output after it, including any minimal fallback.
  const boundaryRow = rows.find((row) => row.id === boundary.id && row.at === boundary.at);
  if (!boundaryRow)
    throw new ConflictError('Scan history changed. Reload and retry.', 'SCAN_HISTORY_CHANGED');
  const final = pageOf(
    await fenceRecords(ctx, cache.proofs.credentialKeysetCommitment, current, cache.actor, {
      row: boundaryRow,
      filter: candidatesFilter,
      now,
    }),
  );
  if (final.boundary && (final.boundary.id !== boundary.id || final.boundary.at !== boundary.at))
    throw new ConflictError('Scan history changed. Reload and retry.', 'SCAN_HISTORY_CHANGED');
  return { items: final.items, nextCursor: final.boundary ? nextCursor : null };
}
