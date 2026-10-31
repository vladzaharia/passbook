import type { EventName } from '../../platform/analytics.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { Scope, Window } from './repo.ts';

/** Analytics SQL binding (`analytics` in wrangler >= 4.145). Not in the generated Env yet. */
export interface AnalyticsSqlBinding {
  query(sql: string): Promise<unknown>;
}

export interface EventRow {
  event: EventName;
  outcome: string;
  t: number;
  n: number;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function analyticsSql(env: AppEnv): AnalyticsSqlBinding | null {
  const binding = (env as unknown as { ANALYTICS_SQL?: Partial<AnalyticsSqlBinding> })
    .ANALYTICS_SQL;
  return typeof binding?.query === 'function' ? (binding as AnalyticsSqlBinding) : null;
}

/** Ids are interpolated into SQL (no bind support), so only plain id characters pass. */
function literal(value: string): string {
  if (!SAFE_ID.test(value)) throw new Error('Unsafe id in analytics query');
  return `'${value}'`;
}

export function eventsQuery(w: Window, scope: Scope, now: number): string {
  const bucketSeconds = Math.floor(w.bucketMs / 1000);
  const filters = [
    `timestamp > toDateTime(${Math.floor(w.since / 1000)})`,
    `timestamp <= toDateTime(${Math.floor(now / 1000)})`,
    ...(scope.orgId ? [`blob2 = ${literal(scope.orgId)}`] : []),
    ...(scope.templateId ? [`blob3 = ${literal(scope.templateId)}`] : []),
  ];
  return `SELECT blob1 AS event, blob5 AS outcome,
    intDiv(toUInt32(timestamp), ${bucketSeconds}) * ${bucketSeconds} AS t, SUM(_sample_interval) AS n
    FROM wallet_events WHERE ${filters.join(' AND ')} GROUP BY event, outcome, t`;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const data = (result as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  throw new Error('Unexpected analytics SQL response');
}

export async function queryEvents(
  binding: AnalyticsSqlBinding,
  w: Window,
  scope: Scope,
  now: number,
): Promise<EventRow[]> {
  const rows = rowsOf(await binding.query(eventsQuery(w, scope, now)));
  return rows.map((r) => ({
    event: String(r.event) as EventName,
    outcome: String(r.outcome),
    t: Number(r.t) * 1000,
    n: Number(r.n),
  }));
}
