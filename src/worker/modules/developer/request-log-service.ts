import type { z } from 'zod';
import type {
  ApiRailSchema,
  RequestLogDetailSchema,
  RequestLogEntrySchema,
  RequestLogQuerySchema,
} from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { apiRateTier, tierLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getKey } from '../api-keys/repo.ts';
import { parseScopes } from '../api-keys/service-dto.ts';
import { sandboxOfUser } from './repo.ts';
import {
  callBuckets,
  FLAG_IDEMPOTENCY_KEY,
  FLAG_IF_MATCH,
  FLAG_VERSION,
  getLog,
  type ListRow,
  LOG_BODY_MS,
  listLogs,
  logCap,
} from './repo-request-log.ts';
import { tryKeyOf } from './repo-try.ts';
import { bodiesRecorded } from './request-log-bodies.ts';
import { headersOf } from './request-log-headers.ts';

type Entry = z.infer<typeof RequestLogEntrySchema>;
type Detail = z.infer<typeof RequestLogDetailSchema>;
type Query = z.infer<typeof RequestLogQuerySchema>;
type Rail = z.infer<typeof ApiRailSchema>;

/**
 * The organization whose log the caller reads: a try token's own, or the signed-in person's sandbox. Never one the
 * caller names, so a log is only ever the caller's.
 */
export async function orgOfCaller(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
): Promise<string> {
  if (auth?.kind === 'api_key' && auth.via === 'try' && auth.orgId) return auth.orgId;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  const sandbox = await sandboxOfUser(ctx.env.DB, auth.userId);
  if (!sandbox) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  return sandbox.org_id;
}

export const entryOf = (r: ListRow, showBodies = true): Entry => ({
  id: r.id,
  requestId: r.request_id,
  at: r.at,
  method: r.method,
  route: r.route,
  path: r.path,
  query: r.query,
  status: r.status,
  code: r.code,
  durationMs: r.duration_ms,
  keyId: r.key_id,
  mode: r.mode,
  via: r.via,
  client: r.client,
  hasBodies: showBodies && r.has_bodies === 1,
  resourceId: r.resource_id,
  apiVersion: r.api_version,
  flags: {
    idempotencyKey: (r.flags & FLAG_IDEMPOTENCY_KEY) !== 0,
    ifMatch: (r.flags & FLAG_IF_MATCH) !== 0,
    version: (r.flags & FLAG_VERSION) !== 0,
  },
});

type Page = {
  items: Entry[];
  nextCursor: string | null;
  capped: 'hour' | 'total' | null;
  bodiesRecorded: boolean;
};

export async function listRequestLog(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  query: Query,
): Promise<Page> {
  return listOrgRequestLog(ctx, await orgOfCaller(ctx, auth), query);
}

/** An org's Test calls, newest first. The caller has already shown authority over `orgId`. */
export async function listOrgRequestLog(
  ctx: ServiceContext,
  orgId: string,
  query: Query & { key?: string },
  /** False: the reader cannot also read passes, so bodies are not offered. */
  showBodies = true,
): Promise<Page> {
  const { cursor, limit, key, ...rest } = query;
  const filter = { ...rest, ...(key && !rest.keyId ? { keyId: key } : {}) };
  const rows = await listLogs(ctx.env.DB, orgId, filter, limit + 1, ctx.clock.now(), cursor);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => entryOf(r, showBodies)),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    capped: await logCap(ctx.env.DB, orgId, ctx.clock.now()),
    bodiesRecorded: await bodiesRecorded(ctx, orgId),
  };
}

export async function getRequestLog(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
): Promise<Detail> {
  return getOrgRequestLog(ctx, await orgOfCaller(ctx, auth), id);
}

export async function getOrgRequestLog(
  ctx: ServiceContext,
  orgId: string,
  id: string,
  /** False: the reader cannot also read passes in this org: metadata only. */
  showBodies = true,
): Promise<Detail> {
  const row = await getLog(ctx.env.DB, orgId, id, ctx.clock.now());
  if (!row) throw new NotFoundError('Request not found.', 'REQUEST_LOG_NOT_FOUND');
  return {
    ...entryOf(row, showBodies),
    requestBody: showBodies ? row.request_body : null,
    responseBody: showBodies ? row.response_body : null,
    bodiesExpireAt: showBodies && row.has_bodies === 1 ? row.at + LOG_BODY_MS : null,
    bodiesTruncated: showBodies && row.bodies_truncated === 1,
    bodiesRecorded: await bodiesRecorded(ctx, orgId),
    headers: headersOf(row.headers),
  };
}

const HOUR = 3_600_000;
const BUCKETS = 12;

/** The last hour in five-minute buckets, oldest first. */
async function lastHour(ctx: ServiceContext, orgId: string, now: number): Promise<number[]> {
  const series = Array.from({ length: BUCKETS }, () => 0);
  for (const { b, n } of await callBuckets(ctx.env.DB, orgId, now - HOUR, HOUR / BUCKETS)) {
    const i = Math.min(BUCKETS - 1, Math.max(0, Math.floor(b)));
    series[i] = (series[i] ?? 0) + n;
  }
  return series;
}

export async function apiRail(ctx: ServiceContext, auth: AuthContext | undefined): Promise<Rail> {
  const orgId = await orgOfCaller(ctx, auth);
  const now = ctx.clock.now();
  const series = await lastHour(ctx, orgId, now);
  const keyId =
    auth?.kind === 'api_key'
      ? auth.keyId
      : auth?.kind === 'session'
        ? (await tryKeyOf(ctx.env.DB, auth.userId, now))?.key_id
        : null;
  const row = keyId ? await getKey(ctx.env.DB, keyId, orgId) : null;
  const tier = apiRateTier(row?.rate_tier, ctx.env);
  return {
    mode: row?.mode ?? 'test',
    scopes: row ? parseScopes(row.scopes) : [],
    tier,
    limitPerMinute: tierLimit(tier),
    callsLastHour: series.reduce((sum, n) => sum + n, 0),
    series,
    key: row ? { id: row.id, name: row.name, prefix: row.prefix } : null,
  };
}
