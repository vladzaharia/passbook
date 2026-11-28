import type { Mode } from '../../../shared/contracts/common.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import type { ScanActor } from './actor.ts';
import type { ConsoleEventRow } from './repo-events.ts';
import { scanLedgerScopeSql } from './repo-feed-scope.ts';
import { scanReadAuthority, scanReadFence } from './repo-read-authority.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { scanEpochsOf } from './scan-epochs.ts';

type Db = D1Database;

import { RACE_EVENT_CACHE_FILL } from './race-tags.ts';
import { expectedCount, expectedCountQuery, type Predicate } from './repo-counts-query.ts';

export {
  eventExpectedCountSql,
  expectedCount,
  expectedCountAfterCacheStmt,
  expectedCountFromResults,
  expectedCountStmt,
} from './repo-counts-query.ts';

/** Today's ok scans by this actor (`scans_actor`). Undone scans and undo rows do not count. */
export const todayStmt = (db: Db, actorKey: string, orgId: string, mode: Mode, since: number) =>
  stmt(
    db,
    `SELECT COUNT(*) AS n FROM scans s
     WHERE s.actor_key = ? AND s.org_id = ? AND s.mode = ? AND s.at >= ?
       AND ${scanLedgerScopeSql('s')}
       AND s.outcome = 'ok' AND s.action_kind != 'undo' AND s.undone_by IS NULL`,
    [actorKey, orgId, mode, since],
  );

export const managersStmt = (db: Db, orgId: string, deskOk = false) =>
  stmt(
    db,
    `SELECT EXISTS (SELECT 1 FROM scan_staff
       WHERE org_id = ? AND role IN ('manager'${deskOk ? ",'desk'" : ''}) AND disabled_at IS NULL) AS has`,
    [orgId],
  );

/** A cached count younger than this is not rewritten; every read still counts live. */
export const EXPECTED_TTL_MS = 60_000;

/**
 * The event's `config_epoch` the actor captured, when the event to count is that very event. The
 * match rule, window, capacity, re-entry, archive state and template list are all in the epoch's
 * bump set, so a row at this epoch is the row the count was bound from.
 */
function capturedEventEpoch(actor: ScanActor, event: ScanEventRow): number | undefined {
  const captured = actor.event;
  return captured &&
    captured.id === event.id &&
    captured.matchInput === event.matchInput &&
    captured.matchValues === event.matchValues &&
    captured.opensAt === event.opensAt &&
    captured.closesAt === event.closesAt &&
    captured.timeZone === event.timeZone &&
    captured.capacity === event.capacity &&
    captured.reentry === event.reentry
    ? scanEpochsOf(actor)?.events[event.id]
    : undefined;
}

/**
 * Compute and cache in one statement: the count and the write share the statement's snapshot, so
 * the cached value was computed from the event row as it is, at the epoch the actor captured, and
 * only while the actor's fence holds. The epoch cannot tell a whole-event selection from an
 * explicit subset, so the counted templates must be the event's own list. `guard` replaces the actor's own fence (writers pass the
 * one they already verified); without it the strict read fence applies, never a relaxed one: a
 * paused session or a staffless device reads but never fills the cache. Null means the optional
 * cache write has no captured epoch or cannot fit below the D1 bind budget, and the caller counts
 * without caching.
 */
export function setExpectedStmt(
  db: Db,
  actor: ScanActor,
  event: ScanEventRow,
  templateIds: readonly string[],
  now: number,
  extra?: Predicate,
): D1PreparedStatement | null {
  const epoch = capturedEventEpoch(actor, event);
  const validSelection =
    event.orgId === actor.orgId &&
    event.mode === actor.mode &&
    templateIds.length > 0 &&
    templateIds.length <= 20 &&
    new Set(templateIds).size === templateIds.length &&
    templateIds.every((id) => typeof id === 'string' && id.length > 0);
  if (epoch === undefined || !validSelection) return null;
  const fence = extra ?? scanReadFence(scanReadAuthority(actor, { now }));
  const count = expectedCountQuery(event, templateIds, now);
  const scope = {
    templateIdSql: 'head_template.id',
    orgIdSql: 'scan_events.org_id',
    modeSql: 'scan_events.mode',
    providerSql: "'apple'",
  };
  const params: SqlValue[] = [
    ...count.params,
    now,
    event.id,
    actor.orgId,
    event.mode,
    now - EXPECTED_TTL_MS,
    epoch,
    templateIds.length,
    JSON.stringify(templateIds),
    ...fence.params,
  ];
  if (params.length >= 100) return null;
  const sql = `${RACE_EVENT_CACHE_FILL} UPDATE scan_events SET expected = (${count.sql}), expected_at = ?
    WHERE id = ? AND org_id = ? AND mode = ?
      AND archived_at IS NULL AND (expected_at IS NULL OR expected_at <= ?)
      AND config_epoch = ?
      AND (SELECT COUNT(*) FROM scan_event_templates et WHERE et.event_id=scan_events.id)=?
      AND NOT EXISTS (SELECT 1 FROM json_each(?) selected WHERE selected.type!='text'
        OR NOT EXISTS (SELECT 1 FROM scan_event_templates et
          WHERE et.event_id=scan_events.id AND et.template_id=selected.value))
      AND (${fence.sql})
      AND NOT EXISTS (
        WITH count_heads AS MATERIALIZED (
          SELECT head_template.id AS template_id, (${effectiveReleaseIdSql(scope)}) AS head_id
          FROM scan_event_templates et
          LEFT JOIN templates head_template ON head_template.id=et.template_id
            AND (head_template.org_id=scan_events.org_id OR head_template.org_id IS NULL)
            AND head_template.status!='deleted'
          WHERE et.event_id=scan_events.id
        )
        SELECT 1 FROM count_heads h LEFT JOIN template_releases head ON head.id=h.head_id
        WHERE h.template_id IS NULL OR typeof(head.id)!='text' OR length(head.id)=0
          OR typeof(head.generation)!='integer' OR head.generation NOT BETWEEN 1 AND 9007199254740991
          OR typeof(head.version)!='text' OR length(head.version)=0
          OR typeof(head.candidate_hash)!='text' OR length(head.candidate_hash)!=64
          OR head.candidate_hash GLOB '*[^0-9a-f]*'
      )
    RETURNING expected AS n`;
  return stmt(db, sql, params);
}

/** Count eligible passes of the event's templates that match its rule. */
export async function countExpected(
  db: Db,
  e: Pick<ConsoleEventRow, 'orgId' | 'mode' | 'templateIds' | 'matchInput' | 'matchValues'>,
  now: number,
): Promise<number> {
  return expectedCount(
    db,
    { ...e, matchValues: e.matchValues === null ? null : JSON.stringify(e.matchValues) },
    e.templateIds,
    now,
  );
}
