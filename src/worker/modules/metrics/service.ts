import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  MetricsOverview,
  MetricsQuery,
  SeriesKey,
} from '../../../shared/contracts/metrics.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsReadable } from '../orgs/repo.ts';
import { analyticsSql, type EventRow, queryEvents } from './analytics-sql.ts';
import * as repo from './repo.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RANGES = {
  '24h': { ms: DAY, bucketMs: HOUR },
  '7d': { ms: 7 * DAY, bucketMs: 6 * HOUR },
  '30d': { ms: 30 * DAY, bucketMs: DAY },
} as const;

const CACHE_TTL_MS = 30_000;
const cache = new WeakMap<D1Database, Map<string, { at: number; value: MetricsOverview }>>();

export function clearMetricsCache(db?: D1Database): void {
  if (db) cache.delete(db);
}

type Rows = Partial<Record<SeriesKey, repo.SeriesRow[]>>;

const D1_UNAVAILABLE: SeriesKey[] = ['downloads'];

async function d1Series(ctx: ServiceContext, w: repo.Window, scope: repo.Scope): Promise<Rows> {
  const db = ctx.env.DB;
  const [
    issued,
    updated,
    refreshes,
    registrations,
    pushes,
    pushFailures,
    emails,
    emailFailures,
    emailUnknown,
    syncRuns,
    signIns,
  ] = await Promise.all([
    repo.issuedRows(db, w, scope),
    repo.updatedRows(db, w, scope, ['admin', 'api', 'connection', 'template_upgrade', 'resign']),
    repo.updatedRows(db, w, scope, ['user_refresh']),
    repo.registrationRows(db, w, scope),
    repo.outboxRows(db, w, scope, 'push', 'all'),
    repo.outboxRows(db, w, scope, 'push', 'failed'),
    repo.outboxRows(db, w, scope, 'email', 'all'),
    repo.outboxRows(db, w, scope, 'email', 'failed'),
    repo.outboxRows(db, w, scope, 'email', 'unknown'),
    repo.syncRunRows(db, w, scope),
    repo.signInRows(db, w, scope),
  ]);
  return {
    issued,
    updated,
    refreshes,
    registrations,
    pushes,
    pushFailures,
    emails,
    emailFailures,
    emailUnknown,
    syncRuns,
    signIns,
  };
}

function aeSeries(events: EventRow[]): Rows {
  const out: Rows = {};
  const add = (key: SeriesKey, row: EventRow) => {
    const list = out[key] ?? [];
    list.push({ t: row.t, n: row.n });
    out[key] = list;
  };
  for (const row of events) {
    const failed = row.outcome !== 'ok';
    switch (row.event) {
      case 'pass.issued':
        add('issued', row);
        break;
      case 'pass.updated':
        add('updated', row);
        break;
      case 'pass.downloaded':
        add('downloads', row);
        break;
      case 'pass.registered':
        add('registrations', row);
        break;
      case 'refresh.requested':
        add('refreshes', row);
        break;
      case 'sync.run':
        add('syncRuns', row);
        break;
      case 'auth.sign_in':
        add('signIns', row);
        break;
      case 'push.result':
        add('pushes', row);
        if (failed) add('pushFailures', row);
        break;
      case 'email.result':
        add('emails', row);
        if (row.outcome === 'unknown') add('emailUnknown', row);
        else if (failed) add('emailFailures', row);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Zero-filled series over [start, end], summing rows that land in the same bucket. */
function fill(rows: repo.SeriesRow[] | undefined, start: number, end: number, bucketMs: number) {
  const sums = new Map<number, number>();
  for (const r of rows ?? []) sums.set(r.t, (sums.get(r.t) ?? 0) + r.n);
  const points: { t: number; v: number }[] = [];
  for (let t = start; t <= end; t += bucketMs) points.push({ t, v: sums.get(t) ?? 0 });
  return points;
}

const SERIES_KEYS: SeriesKey[] = [
  'issued',
  'updated',
  'downloads',
  'registrations',
  'refreshes',
  'pushes',
  'pushFailures',
  'emails',
  'emailFailures',
  'emailUnknown',
  'syncRuns',
  'signIns',
  'scans',
];

async function load(ctx: ServiceContext, w: repo.Window, scope: repo.Scope, now: number) {
  const binding = analyticsSql(ctx.env);
  if (binding) {
    try {
      return {
        source: 'analytics_engine' as const,
        rows: aeSeries(await queryEvents(binding, w, scope, now)),
        unavailable: [] as SeriesKey[],
      };
    } catch (error) {
      ctx.log.warn('metrics.analytics_sql_failed', { error });
    }
  }
  return {
    source: 'd1' as const,
    rows: await d1Series(ctx, w, scope),
    unavailable: D1_UNAVAILABLE,
  };
}

export async function getOverview(
  ctx: ServiceContext,
  query: MetricsQuery,
  mode: Mode = 'live',
  audience: 'tenant' | 'platform' = query.orgId ? 'tenant' : 'platform',
): Promise<MetricsOverview> {
  if (query.orgId && !(await orgIsReadable(ctx.env.DB, query.orgId)))
    throw new ValidationError(
      'Unknown organization.',
      [{ path: 'orgId', message: 'Not found.' }],
      'ORG_NOT_FOUND',
    );

  const now = ctx.clock.now();
  const key = JSON.stringify([audience, query.orgId, query.templateId, query.range, mode]);
  const byKey = cache.get(ctx.env.DB) ?? new Map();
  cache.set(ctx.env.DB, byKey);
  const hit = byKey.get(key);
  // A new platform skips the cache so the checklist ticks at once; its tables are tiny then.
  const settled = hit && hit.value.setup.passEmailsSent > 0;
  if (hit && settled && now >= hit.at && now - hit.at < CACHE_TTL_MS) return hit.value;

  const scope: repo.Scope = { orgId: query.orgId, templateId: query.templateId, mode };
  const range = RANGES[query.range];
  const start = Math.floor((now - range.ms) / range.bucketMs) * range.bucketMs;
  const end = Math.floor(now / range.bucketMs) * range.bucketMs;
  const w: repo.Window = { since: start, bucketMs: range.bucketMs };
  // Platform directory filters expose aggregates, never tenant-specific detail.
  const platformDirectory = audience === 'platform' && Boolean(query.orgId || query.templateId);

  const [totals, loaded, recent, setup] = await Promise.all([
    repo.passTotals(ctx.env.DB, scope),
    load(ctx, w, scope, now),
    platformDirectory
      ? Promise.resolve([])
      : repo.recentAudit(ctx.env.DB, scope, 10, audience === 'tenant'),
    repo.setupCounts(ctx.env.DB, scope, audience === 'tenant' ? mode : 'live', !platformDirectory),
  ]);
  const series = Object.fromEntries(
    SERIES_KEYS.map((k) => [k, fill(loaded.rows[k], start, end, range.bucketMs)]),
  ) as MetricsOverview['series'];
  const sum = (k: SeriesKey) => series[k].reduce((n, p) => n + p.v, 0);

  const value: MetricsOverview = {
    source: loaded.source,
    range: query.range,
    bucketMs: range.bucketMs,
    unavailable: loaded.unavailable,
    totals: {
      passes: totals.passes,
      activePasses: totals.active,
      voidedPasses: totals.voided,
      holders: totals.holders,
      devices: totals.devices,
      issued: sum('issued'),
      updated: sum('updated'),
      downloads: sum('downloads'),
      registrations: sum('registrations'),
      refreshes: sum('refreshes'),
      pushes: sum('pushes'),
      pushFailures: sum('pushFailures'),
      emails: sum('emails'),
      emailFailures: sum('emailFailures'),
      emailUnknown: sum('emailUnknown'),
      syncRuns: sum('syncRuns'),
      signIns: sum('signIns'),
      scans: sum('scans'),
      scanRefused: 0,
    },
    series,
    setup: { ...setup, scanners: 0 },
    live: [],
    recent: recent.map((r) => ({
      at: r.at,
      action:
        audience === 'tenant' && !/^[a-z_]{1,32}\.[a-z_]{1,32}$/.test(r.action)
          ? 'activity'
          : r.action,
      orgId: r.org_id,
      targetId: r.target_id,
    })),
  };
  byKey.set(key, { at: now, value });
  return value;
}
