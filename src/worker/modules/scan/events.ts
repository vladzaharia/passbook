import type { z } from 'zod';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { ScanEventDto, ScanEventListQuerySchema } from '../../../shared/contracts/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { Grant } from '../../platform/authority.ts';
import { AppError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { adminActor, captureScanTenantAuthority, tenantScanRole } from './actor.ts';
import { actorCsrfFence } from './actor-csrf.ts';
import { sessionGrant } from './repo-admin-grant.ts';
import { eventCacheChecks } from './repo-event-authority.ts';
import { type EventAuthority, eventSessionAuthorityValid } from './repo-event-keyset.ts';
import {
  type ConsoleEventRow,
  getAuthorizedConsoleEvent,
  getCommittedConsoleEvent,
  listConsoleEvents,
} from './repo-events.ts';
import { addEventCache } from './repo-events-write.ts';
import { releaseHeadsComplete } from './repo-scope-releases.ts';

export { checkTemplates, checkWindow } from './events-validation.ts';

const EXPECTED_TTL_MS = 60_000;
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
 */
async function refreshExpectedCache(
  ctx: ServiceContext,
  row: ConsoleEventRow,
  authority: EventAuthority,
  cacheBudget?: { remaining: number },
): Promise<void> {
  const n = row.liveExpected;
  if (n === null) throw new Error('Event count was not included in the scoped read.');
  if (!releaseHeadsComplete(row.releaseHeads)) return;
  const now = ctx.clock.now();
  if (row.expected === n && row.expectedAt !== null && row.expectedAt > now - EXPECTED_TTL_MS)
    return;
  if (cacheBudget?.remaining === 0) return;
  if (cacheBudget) cacheBudget.remaining -= 1;
  if (authority.kind !== 'session') return;
  try {
    const g = sessionGrant(
      ctx,
      'org_mode.scan.event.cache',
      authority,
      eventCacheChecks(row),
      row.id,
    );
    addEventCache(g, row.id, n, now);
    await g.commit();
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    ctx.log.info('scan.event_cache_skipped', { orgId: row.orgId, code: error.code });
  }
}

/** A mutation returns only data selected under authority inside its committing transaction. */
export function committedEventView(ctx: ServiceContext, row: ConsoleEventRow): ScanEventDto {
  return toDto(row, ctx.clock.now());
}

function canReadEvents(authority: EventAuthority): boolean {
  return (
    authority.kind === 'session' &&
    (authority.capability === 'scanning:read' || authority.capability === 'scanning:manage')
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
    timeZone: 'UTC',
  });
  actor.tenantAuthority = await captureScanTenantAuthority(ctx, session, authority);
  actor.platformSessionId = session.sessionId;
  actor.role = tenantScanRole(authority);
  if (!actor.role) throw new ForbiddenError();
  const csrfFence = await actorCsrfFence(ctx, actor);
  if (!csrfFence) throw new ForbiddenError();
  return { ...authority, csrfFence };
}

export async function listEvents(
  ctx: ServiceContext,
  mode: Mode,
  query: z.infer<typeof ScanEventListQuerySchema>,
  authority: EventAuthority,
) {
  if (!canReadEvents(authority) || query.orgId !== authority.orgId || mode !== authority.mode)
    return { items: [], nextCursor: null };
  const initial = await listConsoleEvents(ctx.env.DB, {
    ...query,
    mode,
    now: ctx.clock.now(),
    authority,
    limit: query.limit + 1,
  });
  const cacheBudget = { remaining: LIST_CACHE_WRITES };
  for (const row of initial.slice(0, query.limit))
    await refreshExpectedCache(ctx, row, authority, cacheBudget);
  const now = ctx.clock.now();
  const rows = await listConsoleEvents(ctx.env.DB, {
    ...query,
    mode,
    now,
    authority,
    limit: query.limit + 1,
  });
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
  authority: EventAuthority,
): Promise<ConsoleEventRow> {
  if (
    authority.kind !== 'session' ||
    authority.capability !== 'scanning:manage' ||
    authority.userId !== userId
  )
    throw new ForbiddenError();
  const row = await getCommittedConsoleEvent(ctx.env.DB, id, authority.orgId, ctx.clock.now());
  if (!row || row.mode !== authority.mode)
    throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
  return row;
}

async function scopedEventRow(
  ctx: ServiceContext,
  id: string,
  authority: EventAuthority,
  now: number,
): Promise<ConsoleEventRow> {
  const row = await getAuthorizedConsoleEvent(ctx.env.DB, id, authority, now);
  if (!row) {
    if (!(await eventSessionAuthorityValid(ctx.env.DB, authority, now))) throw new ForbiddenError();
    throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
  }
  if (row.orgId !== authority.orgId || row.mode !== authority.mode)
    throw new NotFoundError('Event not found.', 'EVENT_NOT_FOUND');
  return row;
}

export async function eventView(
  ctx: ServiceContext,
  id: string,
  authority: EventAuthority,
): Promise<ScanEventDto> {
  if (!canReadEvents(authority)) throw new ForbiddenError();
  const row = await scopedEventRow(ctx, id, authority, ctx.clock.now());
  await refreshExpectedCache(ctx, row, authority);
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
