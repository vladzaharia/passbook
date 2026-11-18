import type { Mode } from '../../../shared/contracts/common.ts';
import type { MetricsQuery, OrgActivity } from '../../../shared/contracts/metrics.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type * as repo from './repo.ts';
import * as act from './repo-activity.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RANGES = {
  '24h': { ms: DAY, bucketMs: HOUR },
  '7d': { ms: 7 * DAY, bucketMs: 6 * HOUR },
  '30d': { ms: 30 * DAY, bucketMs: DAY },
} as const;

function fill(rows: repo.SeriesRow[], start: number, end: number, bucketMs: number) {
  const sums = new Map(rows.map((r) => [r.t, r.n]));
  const points: { t: number; v: number }[] = [];
  for (let t = start; t <= end; t += bucketMs) points.push({ t, v: sums.get(t) ?? 0 });
  return points;
}

const CACHE_TTL_MS = 60_000;
const cache = new WeakMap<D1Database, Map<string, { at: number; value: OrgActivity }>>();

/** Cached per org, mode and range. Callers check access first; the key never crosses orgs. */
export async function getOrgActivity(
  ctx: ServiceContext,
  query: MetricsQuery & { orgId: string },
  mode: Mode,
): Promise<OrgActivity> {
  const now = ctx.clock.now();
  const byKey = cache.get(ctx.env.DB) ?? new Map();
  cache.set(ctx.env.DB, byKey);
  const key = JSON.stringify([query.orgId, mode, query.range]);
  const hit = byKey.get(key);
  if (hit && now >= hit.at && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await loadOrgActivity(ctx, query, mode);
  byKey.set(key, { at: now, value });
  return value;
}

export function clearActivityCache(db: D1Database): void {
  cache.delete(db);
}

/** An organization's passes, wallet state and scans by template, in one mode. */
async function loadOrgActivity(
  ctx: ServiceContext,
  query: MetricsQuery & { orgId: string },
  mode: Mode,
): Promise<OrgActivity> {
  const now = ctx.clock.now();
  const range = RANGES[query.range];
  const start = Math.floor((now - range.ms) / range.bucketMs) * range.bucketMs;
  const end = Math.floor(now / range.bucketMs) * range.bucketMs;
  const w: repo.Window = { since: start, bucketMs: range.bucketMs };
  const scope: repo.Scope = { orgId: query.orgId, mode };
  const db = ctx.env.DB;
  const [wallet, issued, scans, issuedSeries, scanSeries] = await Promise.all([
    act.walletRows(db, start, { ...scope, orgId: query.orgId }),
    act.issuedByTemplate(db, w, scope),
    act.scansByTemplate(db, w, scope),
    act.issuedSeries(db, w, scope),
    act.scanSeries(db, w, scope),
  ]);
  const issuedBy = new Map(issued.map((r) => [r.template_id, r.n]));
  const scansBy = new Map(scans.map((r) => [r.template_id, r]));
  const templates = wallet
    .map((r) => ({
      templateId: r.template_id,
      name: r.name,
      issued: issuedBy.get(r.template_id) ?? 0,
      added: r.added,
      removed: r.removed,
      scans: scansBy.get(r.template_id)?.scans ?? 0,
      redemptions: scansBy.get(r.template_id)?.redemptions ?? 0,
      inWallet: r.in_wallet,
      notAdded: r.not_added,
    }))
    .sort((a, b) => b.issued + b.inWallet + b.notAdded - (a.issued + a.inWallet + a.notAdded));
  const sum = (key: Exclude<keyof (typeof templates)[number], 'templateId' | 'name'>) =>
    templates.reduce((n, t) => n + t[key], 0);
  return {
    range: query.range,
    bucketMs: range.bucketMs,
    totals: {
      issued: sum('issued'),
      added: sum('added'),
      removed: sum('removed'),
      scans: sum('scans'),
      redemptions: sum('redemptions'),
      inWallet: sum('inWallet'),
      notAdded: sum('notAdded'),
    },
    series: {
      issued: fill(issuedSeries, start, end, range.bucketMs),
      scans: fill(scanSeries, start, end, range.bucketMs),
    },
    templates,
  };
}
