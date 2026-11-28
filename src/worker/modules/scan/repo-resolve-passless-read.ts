import { PRESENT } from '../../platform/authority-read.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './guard.ts';
import { eventMatchSql } from './repo-event-match.ts';
import { type ScanReadAuthority, scanRead } from './repo-read-authority.ts';
import type { Fence } from './repo-read-fences.ts';
import { type CandidateMatchInput, candidateMatchPredicate } from './repo-resolve-candidates.ts';

/**
 * Some pass of the tenant matches the input (`null`: the code cleaned to nothing, so none does),
 * narrowed by `filter` over the pass row `p`. `org` and `mode` are SQL: `ao` columns in a read,
 * `{org}` and `{mode}` in a grant check.
 */
export function matchingPassSql(
  input: CandidateMatchInput | null,
  tenant: { org: string; mode: string },
  filter?: Fence,
): Fence {
  if (!input) return { sql: '0', params: [] };
  const matches = candidateMatchPredicate(input);
  return {
    sql: `EXISTS (SELECT 1 FROM passes p WHERE p.org_id = ${tenant.org} AND p.mode = ${tenant.mode}
      AND (${matches.sql})${filter ? ` AND (${filter.sql})` : ''})`,
    params: [...matches.params, ...(filter?.params ?? [])],
  };
}

const ELIGIBLE = 'p.deleted_at IS NULL AND p.test_data_quarantined = 0';

/** A same-mode pass the actor could scan: live, and not hidden by a cross-mode or unconfirmed state. */
export const candidateEligible: Fence = { sql: ELIGIBLE, params: [] };

/**
 * A pass the actor's current acceptance takes (its templates, and with `includeEvent` the event's
 * pass filter): a newly appearing one makes a "not accepted" or "wrong event" answer stale.
 */
export function acceptedFilter(actor: ScanActor, includeEvent: boolean): Fence {
  const params: SqlValue[] = [];
  const parts = [ELIGIBLE];
  if (actor.templateIds.length) {
    parts.push("p.template_id IN (SELECT value FROM json_each(?) WHERE type = 'text')");
    params.push(JSON.stringify(actor.templateIds));
  } else if (
    !((actor.principal === 'admin' && actor.scanner === null) || actor.settings.acceptAllTemplates)
  )
    parts.push('0');
  if (includeEvent && actor.event) {
    parts.push(`EXISTS (SELECT 1 FROM scan_events event_filter
      WHERE event_filter.id = ? AND event_filter.org_id = p.org_id AND event_filter.mode = p.mode
        AND ${eventMatchSql('event_filter', 'p')})`);
    params.push(actor.event.id);
  }
  return { sql: parts.join(' AND '), params };
}

/** The negation of a fence: the answer holds only while it does not. */
export const absent = (fence: Fence): Fence => ({
  sql: `NOT (${fence.sql})`,
  params: fence.params,
});

/** One row when the actor's authority holds and every part does. */
export function passlessStmt(
  db: D1Database,
  auth: ScanReadAuthority,
  parts: readonly Fence[],
): D1PreparedStatement {
  return scanRead(
    db,
    auth,
    `SELECT 1 AS ok FROM actor_ok ao WHERE ${PRESENT} = 1 AND ${parts.map((part) => `(${part.sql})`).join(' AND ')}`,
    parts.flatMap((part) => part.params),
  );
}
