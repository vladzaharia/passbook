/* The count query shared by the cache write (repo-counts.ts) and the uncached reads. */
import type { Mode } from '../../../shared/contracts/common.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import { issuedReleasePredicateSql, noScopedReleaseSql } from '../templates/repo-releases.ts';
import { eventMatch, eventMatchSql } from './repo-event-match.ts';
import { walletSnapshotPredicateSql } from './repo-wallet-snapshot.ts';

const MATCH_CURRENT_INPUT = ` AND EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(p.personalization) THEN p.personalization ELSE '{}' END) input
  JOIN json_each(?) allowed ON allowed.type='text' AND CAST(input.value AS TEXT)=allowed.value
  WHERE input.key=? AND input.type IN ('text','integer','real','true','false')
)`;
const passScope = {
  templateIdSql: 'p.template_id',
  orgIdSql: 'p.org_id',
  modeSql: 'p.mode',
  providerSql: "'apple'",
};
const ELIGIBLE_PASS = `EXISTS (
  SELECT 1 FROM templates scoped_t
  JOIN template_versions pinned ON pinned.template_id=p.template_id AND pinned.version=p.template_version
  LEFT JOIN template_releases head ON head.id=(${effectiveReleaseIdSql(passScope)})
  LEFT JOIN template_versions active ON active.template_id=p.template_id AND active.version=head.version
  WHERE ((scoped_t.id=p.template_id AND (scoped_t.org_id=p.org_id OR scoped_t.org_id IS NULL)
      AND scoped_t.status!='deleted')
    AND ((typeof(p.credential_generation)='integer' AND p.credential_generation>=1)
      AND (typeof(p.lifecycle_generation)='integer' AND p.lifecycle_generation>=0)))
    AND (((NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
      WHERE transfer.pass_id=p.id AND transfer.state='pending'))
      AND (p.release_id IS NULL OR (${issuedReleasePredicateSql(
        { releaseIdSql: 'p.release_id', versionSql: 'p.template_version' },
        passScope,
      )})))
      AND ((head.id IS NULL AND p.release_id IS NULL AND (${noScopedReleaseSql(passScope)}))
        OR (head.id IS NOT NULL AND (p.template_version=head.version
          OR (pinned.build_key IS NOT NULL AND active.build_key=pinned.build_key)))))
)`;

/**
 * Correlated form for an event row and its tenant/release fence in the same D1 snapshot.
 * Both arguments are trusted SQL expressions; `nowSql` appears once in the result.
 */
export function eventExpectedCountSql(eventAlias: string, nowSql: string): string {
  return `(SELECT COUNT(*) FROM passes p
    WHERE p.org_id=${eventAlias}.org_id AND p.mode=${eventAlias}.mode
      AND p.deleted_at IS NULL AND p.removed_at IS NULL AND p.status='active'
      AND p.test_data_quarantined=0
      AND p.template_id IN (SELECT et.template_id FROM scan_event_templates et WHERE et.event_id=${eventAlias}.id)
      AND ${ELIGIBLE_PASS} AND (${walletSnapshotPredicateSql({ nowSql })})
      AND ${eventMatchSql(eventAlias, 'p')}
  )`;
}

type Db = D1Database;

export type CountEvent = {
  orgId: string;
  mode: Mode;
  matchInput: string | null;
  matchValues: string | null;
};
export type Predicate = { sql: string; params: readonly SqlValue[] };

/** The same captured selection is used for both the cache CAS and an uncached result. */
export function expectedCountQuery(
  event: CountEvent,
  templateIds: readonly string[],
  now: number,
): Predicate {
  if (!templateIds.length) return { sql: 'SELECT 0', params: [] };
  const match = eventMatch(event.matchInput, event.matchValues);
  if (!match) return { sql: 'SELECT 0', params: [] };
  return {
    sql: `WITH selected AS MATERIALIZED (
      SELECT p.* FROM passes p
      WHERE (p.org_id = ? AND p.mode = ?) AND (p.deleted_at IS NULL AND p.removed_at IS NULL AND p.status = 'active')
        AND (p.test_data_quarantined = 0 AND p.template_id IN (SELECT value FROM json_each(?) WHERE type='text'))
    ), release_checks AS MATERIALIZED (
      SELECT p.*,
        (${effectiveReleaseIdSql(passScope)}) AS count_head_id,
        (${issuedReleasePredicateSql(
          { releaseIdSql: 'p.release_id', versionSql: 'p.template_version' },
          passScope,
        )}) AS count_issued_valid,
        (${noScopedReleaseSql(passScope)}) AS count_no_history
      FROM selected p
    ), eligible AS MATERIALIZED (
      SELECT p.* FROM release_checks p
      JOIN templates scoped_t ON scoped_t.id=p.template_id
      JOIN template_versions pinned ON pinned.template_id=p.template_id AND pinned.version=p.template_version
      LEFT JOIN template_releases head ON head.id=p.count_head_id
      LEFT JOIN template_versions active ON active.template_id=p.template_id AND active.version=head.version
      WHERE ((scoped_t.org_id=p.org_id OR scoped_t.org_id IS NULL) AND scoped_t.status!='deleted')
        AND ((typeof(p.credential_generation)='integer' AND p.credential_generation>=1)
          AND (typeof(p.lifecycle_generation)='integer' AND p.lifecycle_generation>=0))
        AND (NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
          WHERE transfer.pass_id=p.id AND transfer.state='pending')
          AND (p.release_id IS NULL OR p.count_issued_valid))
        AND ((head.id IS NULL AND p.release_id IS NULL AND p.count_no_history)
          OR (head.id IS NOT NULL AND (p.template_version=head.version
            OR (pinned.build_key IS NOT NULL AND active.build_key=pinned.build_key))))
    )
    SELECT COUNT(*) FROM eligible p
      WHERE (${walletSnapshotPredicateSql({ nowSql: '?' })})${match.input === null ? '' : MATCH_CURRENT_INPUT}`,
    params: [
      event.orgId,
      event.mode,
      JSON.stringify(templateIds),
      now,
      ...(match.input === null ? [] : [JSON.stringify(match.values), match.input]),
    ],
  };
}

/** A standalone prepared count for callers which do not write the event cache. */
export function expectedCountStmt(
  db: Db,
  event: CountEvent,
  templateIds: readonly string[],
  now: number,
): D1PreparedStatement {
  const count = expectedCountQuery(event, templateIds, now);
  return stmt(db, `SELECT (${count.sql}) AS n`, count.params);
}

/**
 * Place immediately after `setExpectedStmt` in the same batch. SQLite's `changes()`
 * avoids a second pass over eligible Wallets when the CAS returned the computed count.
 */
export function expectedCountAfterCacheStmt(
  db: Db,
  event: CountEvent,
  templateIds: readonly string[],
  now: number,
): D1PreparedStatement {
  const count = expectedCountQuery(event, templateIds, now);
  return stmt(db, `SELECT CASE WHEN changes()=0 THEN (${count.sql}) END AS n`, count.params);
}

/** Decode a count whether it came from the cache CAS or its immediately following read. */
export function expectedCountFromResults(
  cached: D1Result | undefined,
  uncached: D1Result | undefined,
): number {
  const cachedRow = cached?.results?.[0] as { n?: unknown } | undefined;
  const uncachedRow = uncached?.results?.[0] as { n?: unknown } | undefined;
  const value = cachedRow?.n ?? uncachedRow?.n;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Expected-count batch did not return a valid count.');
  return value;
}

/** Count eligible passes of the selected templates that match the event rule. */
export async function expectedCount(
  db: Db,
  event: CountEvent,
  templateIds: readonly string[],
  now: number,
): Promise<number> {
  const count = expectedCountQuery(event, templateIds, now);
  // Empty selections and invalid rules do not need a standalone D1 read.
  if (!count.params.length) return 0;
  const row = await stmt(db, `SELECT (${count.sql}) AS n`, count.params).first<{ n: number }>();
  return row?.n ?? 0;
}
