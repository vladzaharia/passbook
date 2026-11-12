import type { Mode } from '../../../shared/contracts/common.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import type { ScanActor } from './actor.ts';
import { packedPredicate } from './repo-action-authority.ts';
import { actorAuthorityPredicates } from './repo-actor-authority.ts';
import type { ConsoleEventRow } from './repo-events.ts';
import { scanLedgerScopeSql } from './repo-feed-scope.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { usableScanTemplateSql } from './repo-scope-releases.ts';
import { scanEpochsOf } from './scan-epochs.ts';

type Db = D1Database;

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

export const managersStmt = (db: Db, orgId: string) =>
  stmt(
    db,
    `SELECT EXISTS (SELECT 1 FROM scan_staff
       WHERE org_id = ? AND role = 'manager' AND disabled_at IS NULL) AS has`,
    [orgId],
  );

/**
 * Keep the original admission scope's release/legacy-Wallet proof out of the
 * scanner/session anti-join and metadata packer, in the same statement snapshot.
 */
function admissionReleaseChecks(actor: ScanActor, fences: Predicate[]): Predicate | null {
  if (!actor.scanner || actor.event || !actor.templateIds.length) return null;
  const scope = {
    templateIdSql: 't.id',
    orgIdSql: actor.scanningSession ? 'ss.org_id' : 'scoped_s.org_id',
    modeSql: actor.scanningSession ? 'ss.mode' : 'scoped_s.mode',
    providerSql: "'apple'",
  };
  const nested = usableScanTemplateSql(scope);
  const matches = fences.filter((fence) => fence.sql.includes(nested));
  if (matches.length > 1) return null;

  // An actor without captured epochs carries the nested release proof in its fence: hoist it
  // here. With epochs the fence has none, and this check is the only one on the assigned rows.
  // Either way release usability is checked for the actual assigned rows, including IDs that do
  // not match the actor's captured selection.
  const [nestedFence] = matches;
  if (nestedFence) nestedFence.sql = nestedFence.sql.replace(nested, '1');
  const session = actor.scanningSession;
  const current = {
    templateIdSql: 't.id',
    orgIdSql: session ? 'current_session.org_id' : 'current_scanner.org_id',
    modeSql: session ? 'current_session.mode' : 'current_scanner.mode',
    providerSql: "'apple'",
  };
  const source = session
    ? `FROM scanning_sessions current_session
      JOIN json_each(CASE WHEN json_valid(current_session.accepts)
        THEN current_session.accepts ELSE '{}' END, '$.templateIds') selected
      JOIN templates t ON t.id=selected.value
      WHERE current_session.id=?/* scan-ephemeral-session-id */`
    : `FROM scanner_templates selected
      JOIN scanners current_scanner ON current_scanner.id=selected.scanner_id
      JOIN templates t ON t.id=selected.template_id
      WHERE selected.scanner_id=?/* scan-ephemeral-scanner-id */`;
  return {
    sql: `count_admission_scope AS MATERIALIZED (
      SELECT (${usableScanTemplateSql(current)}) AS usable
      ${source}
    )`,
    params: [session?.id ?? actor.scanner.id],
  };
}

/**
 * Compute and cache in one statement only for the original authorized actor, complete event
 * selection, and currently valid release heads. The count and every release/Wallet check share
 * the statement's snapshot; there is no window in which a previously counted value can go stale.
 * Null means the optional cache write cannot fit below the D1 bind budget.
 */
export function setExpectedStmt(
  db: Db,
  actor: ScanActor,
  event: ScanEventRow,
  templateIds: readonly string[],
  now: number,
  extra?: Predicate,
): D1PreparedStatement | null {
  const count = expectedCountQuery(event, templateIds, now);
  const actorFences = actorAuthorityPredicates({
    actor,
    event,
    now,
    adminEventTemplates: actor.adminEventTemplates === true,
  });
  const admission = admissionReleaseChecks(actor, actorFences);
  // The event fence already contains materialized release checks; nesting it inside the
  // metadata packer exceeds D1's expression depth. Pack the surrounding checks together.
  const authority: { sql: string; params: readonly SqlValue[] }[] = [];
  let pending: typeof actorFences = [];
  const flush = () => {
    if (!pending.length) return;
    authority.push(
      packedPredicate(
        pending.map((fence) => `(${fence.sql})`).join(' AND '),
        pending.flatMap((fence) => fence.params),
      ),
    );
    pending = [];
  };
  for (const fence of actorFences) {
    if (fence.sql.startsWith('COALESCE((WITH actor_event AS MATERIALIZED')) {
      flush();
      authority.push(fence);
    } else pending.push(fence);
  }
  flush();
  const guard = extra ? packedPredicate(extra.sql, [...extra.params]) : undefined;
  const keyset = actor.credentialKeysetCommitment;
  const validSelection =
    event.orgId === actor.orgId &&
    event.mode === actor.mode &&
    templateIds.length > 0 &&
    templateIds.length <= 20 &&
    new Set(templateIds).size === templateIds.length &&
    templateIds.every((id) => typeof id === 'string' && id.length > 0);
  const validKeyset = keyset === undefined || /^[0-9a-f]{64}$/.test(keyset);
  const scope = {
    templateIdSql: 'head_template.id',
    orgIdSql: 'scan_events.org_id',
    modeSql: 'scan_events.mode',
    providerSql: "'apple'",
  };
  // An event the guard captured is compared by its config epoch (match rule, window, capacity and
  // template list all move it). One it did not (an admission's own event) keeps the column
  // comparison, never `updated_at`. Session scope rides the session epoch inside the actor fences;
  // a scanner's template list has no epoch and stays an exact comparison.
  const templates = JSON.stringify(templateIds);
  // The epoch vouches for the event the actor captured: the counted snapshot must be that one.
  const captured = actor.event;
  const eventEpoch =
    captured &&
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
  const eventFence =
    eventEpoch === undefined
      ? {
          sql: `match_input IS ?/* scan-ephemeral-event-match-input */
        AND match_values IS ?/* scan-ephemeral-event-match-values */
        AND opens_at = ? AND closes_at = ? AND time_zone = ?/* scan-ephemeral-event-time-zone */
        AND capacity IS ? AND reentry = ?`,
          params: [
            event.matchInput,
            event.matchValues,
            event.opensAt,
            event.closesAt,
            event.timeZone,
            event.capacity,
            event.reentry ? 1 : 0,
          ] as SqlValue[],
        }
      : { sql: 'config_epoch = ?', params: [eventEpoch] as SqlValue[] };
  let scopeSql = '';
  const scopeParams: SqlValue[] = [];
  if (actor.scanner && !actor.event && !actor.scanningSession) {
    scopeSql = `AND (SELECT COUNT(*) FROM scanner_templates st WHERE st.scanner_id=?)=?
        AND NOT EXISTS (SELECT 1 FROM scanner_templates st
          WHERE st.scanner_id=? AND st.template_id NOT IN (SELECT value FROM json_each(?)))`;
    scopeParams.push(
      actor.scanner.id,
      actor.templateIds.length,
      actor.scanner.id,
      JSON.stringify(actor.templateIds),
    );
  }
  const sql = `UPDATE scan_events SET expected = (${count.sql}), expected_at = ?
    WHERE (id = ?/* scan-ephemeral-event-id */ AND org_id = ? AND mode = ?
      AND archived_at IS NULL AND (expected_at IS NULL OR expected_at <= ?)
      AND ${eventFence.sql}
      AND (SELECT COUNT(*) FROM scan_event_templates et WHERE et.event_id=scan_events.id)=?
      AND NOT EXISTS (SELECT 1 FROM json_each(?) selected WHERE selected.type!='text'
        OR NOT EXISTS (SELECT 1 FROM scan_event_templates et
          WHERE et.event_id=scan_events.id AND et.template_id=selected.value)))
      AND ((${validSelection && validKeyset ? '1' : '0'} AND EXISTS (
        WITH ${admission ? `${admission.sql}, ` : ''}${authority.map((fence, i) => `count_authority_${i} AS MATERIALIZED (SELECT (${fence.sql}) AS allowed)`).join(', ')}
        ${guard ? `, count_guard AS MATERIALIZED (SELECT (${guard.sql}) AS allowed)` : ''}
        SELECT 1 FROM ${authority.map((_, i) => `count_authority_${i}`).join(', ')} ${guard ? ', count_guard' : ''}
        WHERE ${authority.map((_, i) => `count_authority_${i}.allowed`).join(' AND ')} ${guard ? 'AND count_guard.allowed' : ''}
          ${
            admission
              ? `AND NOT EXISTS (SELECT 1 FROM count_admission_scope a
            WHERE NOT a.usable)`
              : ''
          }
      ))
        ${keyset === undefined ? '' : `AND (${credentialRefKeysetSql.replace('?', '?/* scan-ephemeral-proof */')})`})
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
      ${scopeSql}
    RETURNING expected AS n`;
  const params: SqlValue[] = [
    ...count.params,
    now,
    event.id,
    actor.orgId,
    event.mode,
    now,
    ...eventFence.params,
    templateIds.length,
    templates,
    ...(admission?.params ?? []),
    ...authority.flatMap((fence) => fence.params),
    ...(guard?.params ?? []),
    ...(keyset === undefined ? [] : [keyset]),
    ...scopeParams,
  ];
  if (params.length >= 100) return null;
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
