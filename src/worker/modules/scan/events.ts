import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanEventDto, ScanEventListQuerySchema } from '../../../shared/contracts/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { Grant } from '../../platform/authority.ts';
import { AppError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { grantAuthorityOf, sessionGrant } from './repo-admin-grant.ts';
import { EXPECTED_TTL_MS } from './repo-counts.ts';
import { eventCacheChecks } from './repo-event-authority.ts';
import type { EventAuthority } from './repo-event-keyset.ts';
import {
  type ConsoleEventRow,
  getAuthorizedConsoleEvent,
  getCommittedConsoleEvent,
  getConsoleEventTarget,
  listConsoleEvents,
} from './repo-events.ts';
import { addEventCache } from './repo-events-write.ts';
import { readOrgTimeZone } from './repo-org-clock.ts';
import { keyScanReadAuthority, scanReadAuthority } from './repo-read-authority.ts';
import { releaseHeadsComplete } from './repo-scope-releases.ts';

export { checkTemplates, checkWindow } from './events-validation.ts';

/** Every returned count is live; at most ten cache writes are attempted per page. */
const LIST_CACHE_WRITES = 10;

export function eventStatus(row: ConsoleEventRow, now: number): ScanEventDto['status'] {
  if (row.archivedAt !== null) return 'archived';
  if (now < row.opensAt) return 'upcoming';
  return now > row.closesAt ? 'ended' : 'live';
}

function toDto(row: ConsoleEventRow, now: number): ScanEventDto {
  const expected = row.liveExpected;
  if (expected === null) throw new Error('Event count was not included in the scoped read.');
  return {
    id: row.id,
    orgId: row.orgId,
    mode: row.mode,
    name: row.name,
    templateIds: row.templateIds,
    match:
      row.matchInput && row.matchValues ? { input: row.matchInput, values: row.matchValues } : null,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
    timeZone: row.timeZone,
    capacity: row.capacity,
    reentry: row.reentry,
    hardLimit: row.hardLimit,
    note: row.note,
    status: eventStatus(row, now),
    arrived: row.arrived,
    expected,
    scanners: row.scanners,
  };
}

/**
 * Cache the initial live count only while the event is the one the count was derived from. A cache
 * fill is best effort: losing a race to an edit, or the access, skips it and never fails the read.
 * The fills of one page commit as one grant; when it is refused each is retried alone, so one
 * raced event costs only its own fill.
 */
async function refreshExpectedCaches(
  ctx: ServiceContext,
  rows: readonly ConsoleEventRow[],
  authority: EventReader,
  budget = Number.POSITIVE_INFINITY,
): Promise<void> {
  const now = ctx.clock.now();
  const fills: { row: ConsoleEventRow; n: number }[] = [];
  for (const row of rows) {
    const n = row.liveExpected;
    if (n === null) throw new Error('Event count was not included in the scoped read.');
    if (!releaseHeadsComplete(row.releaseHeads)) continue;
    if (row.expected === n && row.expectedAt !== null && row.expectedAt > now - EXPECTED_TTL_MS)
      continue;
    if (fills.length < budget) fills.push({ row, n });
  }
  if (authority.kind !== 'session' || fills.length === 0) return;
  const commit = async (batch: typeof fills) => {
    const [only] = batch;
    const g = sessionGrant(
      ctx,
      'org_mode.scan.event.cache',
      authority,
      batch.flatMap((fill) => eventCacheChecks(fill.row)),
      batch.length === 1 ? only?.row.id : undefined,
    );
    for (const fill of batch) addEventCache(g, fill.row.id, fill.n, now);
    await g.commit();
  };
  const skippable = (error: unknown): error is AppError =>
    error instanceof AppError && error.status < 500;
  try {
    await commit(fills);
    return;
  } catch (error) {
    if (!skippable(error)) throw error;
    if (fills.length === 1) {
      ctx.log.info('scan.event_cache_skipped', { orgId: fills[0]?.row.orgId, code: error.code });
      return;
    }
  }
  for (const fill of fills) {
    try {
      await commit([fill]);
    } catch (error) {
      if (!skippable(error)) throw error;
      ctx.log.info('scan.event_cache_skipped', { orgId: fill.row.orgId, code: error.code });
    }
  }
}

/** A mutation returns only data selected under authority inside its committing transaction. */
export function committedEventView(ctx: ServiceContext, row: ConsoleEventRow): ScanEventDto {
  return toDto(row, ctx.clock.now());
}

function canReadEvents(authority: EventReader): boolean {
  return (
    authority.kind === 'api_key' ||
    (authority.kind === 'session' &&
      (authority.capability === 'scanning:read' || authority.capability === 'scanning:manage'))
  );
}

/** Capture the original session proof and retain its SQL secret only as ephemeral scalar binds. */
export async function captureEventAuthority(
  ctx: ServiceContext,
  session: SessionAuth,
  authority: TenantPassWrite,
): Promise<EventAuthority> {
  if (authority.kind !== 'session') throw new ForbiddenError();
  const actor = adminActor(session, authority.mode, {
    orgId: authority.orgId,
    event: null,
    templateIds: [],
    timeZone: await readOrgTimeZone(ctx.env.DB, authority.orgId),
  });
  actor.tenantAuthority = await captureScanTenantAuthority(ctx, session, authority);
  actor.platformSessionId = session.sessionId;
  actor.role = tenantScanRole(authority);
  if (!actor.role) throw new ForbiddenError();
  await captureScanEpochs(ctx.env.DB, actor);
  return { ...authority, actor };
}

/** A console session (its captured actor) or an org-bound `scan-setup:read` key. */
export type EventReader = EventAuthority | Extract<TenantPassWrite, { kind: 'api_key' }>;

const readAt = (authority: EventReader, now: number) =>
  authority.kind === 'api_key'
    ? keyScanReadAuthority(authority, now)
    : scanReadAuthority(authority.actor, { now });
const readAuth = (ctx: ServiceContext, authority: EventReader) =>
  readAt(authority, ctx.clock.now());

/** Where an event lives, before any tenant authority exists for it. */
export async function eventTarget(ctx: ServiceContext, id: string) {
  return getConsoleEventTarget(ctx.env.DB, id);
}

export async function listEvents(
  ctx: ServiceContext,
  mode: Mode,
  query: z.infer<typeof ScanEventListQuerySchema>,
  authority: EventReader,
) {
  if (!canReadEvents(authority) || query.orgId !== authority.orgId || mode !== authority.mode)
    return { items: [], nextCursor: null };
  const initial = await listConsoleEvents(ctx.env.DB, readAuth(ctx, authority), {
    ...query,
    now: ctx.clock.now(),
    limit: query.limit + 1,
  });
  await refreshExpectedCaches(
    ctx,
    initial.rows.slice(0, query.limit),
    authority,
    LIST_CACHE_WRITES,
  );
  const now = ctx.clock.now();
  const { authorized, rows } = await listConsoleEvents(ctx.env.DB, readAuth(ctx, authority), {
    ...query,
    now,
    limit: query.limit + 1,
  });
  if (!authorized) return { items: [], nextCursor: null };
  const page = rows.slice(0, query.limit);
  return {
    items: page.map((row) => toDto(row, now)),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** The mutation target in the managing session's org and mode. The grant proves the authority at commit. */
export async function loadManageEvent(
  ctx: ServiceContext,
  id: string,
  userId: string,
  authority: TenantPassWrite,
): Promise<ConsoleEventRow> {
  grantAuthorityOf(authority, userId, authority.orgId);
  const row = await getCommittedConsoleEvent(ctx.env.DB, id, authority.orgId, ctx.clock.now());
  if (!row || row.mode !== authority.mode)
    throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
  return row;
}

async function scopedEventRow(
  ctx: ServiceContext,
  id: string,
  authority: EventReader,
  now: number,
): Promise<ConsoleEventRow> {
  const { authorized, row } = await getAuthorizedConsoleEvent(
    ctx.env.DB,
    id,
    readAt(authority, now),
    now,
  );
  if (!authorized) throw new ForbiddenError();
  if (!row) throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
  return row;
}

export async function eventView(
  ctx: ServiceContext,
  id: string,
  authority: EventReader,
): Promise<ScanEventDto> {
  if (!canReadEvents(authority)) throw new ForbiddenError();
  const row = await scopedEventRow(ctx, id, authority, ctx.clock.now());
  await refreshExpectedCaches(ctx, [row], authority);
  const now = ctx.clock.now();
  const current = await scopedEventRow(ctx, id, authority, now);
  return toDto(current, now);
}

/**
 * Commit the grant, then answer with the committed event. The grant is the authority check: a
 * refusal is a classified 403 or 409 and nothing is written; once it commits it is not undone.
 */
export async function commitEvent(
  ctx: ServiceContext,
  g: Grant,
  eventId: string,
  orgId: string,
): Promise<ConsoleEventRow> {
  await g.commit();
  const row = await getCommittedConsoleEvent(ctx.env.DB, eventId, orgId, ctx.clock.now());
  if (!row) throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
  return row;
}
