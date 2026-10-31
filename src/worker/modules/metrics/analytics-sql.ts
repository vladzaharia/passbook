import type { EventName } from '../../platform/analytics.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { Scope, Window } from './repo.ts';

/** Dataset name as bound by `analytics_engine_datasets` in wrangler.jsonc. */
const DATASET = 'events.analyticsEngine.wallet_events';

export interface EventRow {
  event: EventName;
  outcome: string;
  t: number;
  n: number;
}

/** Analytics SQL binding (`analytics` in wrangler.jsonc). Absent in tests and local dev. */
export function analyticsSql(env: AppEnv): AnalyticsSQLBinding | null {
  const binding = (env as Partial<Pick<Env, 'ANALYTICS_SQL'>>).ANALYTICS_SQL;
  return typeof binding?.query === 'function' ? binding : null;
}

/**
 * The binding supplies account scope, applies sample weights to COUNT and takes bound params.
 * Only the lower time bound is mandatory.
 */
export function eventsQuery(w: Window, scope: Scope, now: number): AnalyticsSQLQuery {
  const bucketSeconds = Math.max(1, Math.floor(w.bucketMs / 1000));
  const params: Record<string, string> = {
    since: new Date(w.since).toISOString(),
    until: new Date(now).toISOString(),
  };
  const filters = ['timestamp > $since', 'timestamp <= $until'];
  if (scope.orgId) {
    filters.push('blob2 = $orgId');
    params.orgId = scope.orgId;
  }
  if (scope.templateId) {
    filters.push('blob3 = $templateId');
    params.templateId = scope.templateId;
  }
  return {
    query: `SELECT blob1 AS event, blob5 AS outcome,
      toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '${bucketSeconds}' SECOND)) AS t,
      COUNT(*) AS n
      FROM ${DATASET} WHERE ${filters.join(' AND ')} GROUP BY event, outcome, t`,
    params,
  };
}

export async function queryEvents(
  binding: AnalyticsSQLBinding,
  w: Window,
  scope: Scope,
  now: number,
): Promise<EventRow[]> {
  const result = await binding.query(eventsQuery(w, scope, now));
  if (!Array.isArray(result?.data)) throw new Error('Unexpected analytics SQL response');
  return result.data.map((r) => ({
    event: String(r.event) as EventName,
    outcome: String(r.outcome),
    t: Number(r.t) * 1000,
    n: Number(r.n),
  }));
}
