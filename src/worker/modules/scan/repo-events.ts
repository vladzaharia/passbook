import type { Mode } from '../../../shared/contracts/common.ts';
import { first, prefixMatch, type SqlValue } from '../../platform/db.ts';
import { eventExpectedCountSql } from './repo-counts.ts';
import { eventArrivedCountSql } from './repo-event-attendance.ts';
import { type ScanReadAuthority, scanAuthorizedStmt, scanRead } from './repo-read-authority.ts';
import { templateReleaseHeadsSql } from './repo-scope-releases.ts';

type Db = D1Database;

export interface ConsoleEventRow {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  matchInput: string | null;
  matchValues: string[] | null;
  opensAt: number;
  closesAt: number;
  timeZone: string;
  capacity: number | null;
  reentry: boolean;
  hardLimit: boolean;
  note: string | null;
  expected: number | null;
  expectedAt: number | null;
  /** Computed in the same authorized snapshot as this event, never served from cache. */
  liveExpected: number | null;
  archivedAt: number | null;
  templateIds: string[];
  /** All stored links are retained privately for the configuration CAS. */
  storedTemplateIds: string[];
  releaseHeads: string;
  arrived: number;
  scanners: number;
  updatedAt: number;
  /** Trigger-owned: what an edit or cache fill derived from this row is checked against. */
  configEpoch: number;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  name: string;
  match_input: string | null;
  match_values: string | null;
  opens_at: number;
  closes_at: number;
  time_zone: string;
  capacity: number | null;
  reentry: number;
  hard_limit: number;
  note: string | null;
  expected: number | null;
  expected_at: number | null;
  live_expected: number | null;
  archived_at: number | null;
  template_ids: string | null;
  stored_template_ids: string | null;
  release_heads: string;
  arrived: number;
  scanners: number;
  updated_at: number;
  config_epoch: number;
}

const scopedEventTemplates = `SELECT x.template_id FROM scan_event_templates x
  JOIN templates t ON t.id=x.template_id AND (t.org_id=e.org_id OR t.org_id IS NULL)
    AND t.status!='deleted'
  WHERE x.event_id=e.id`;

/** Relationship counts and returned identifiers must belong to the event's scope. */
const eventSelect = (
  expectedSql: string,
  arrivedSql: string,
  from = '',
) => `SELECT e.id, e.org_id, e.mode, e.name, e.match_input, e.match_values, e.opens_at, e.closes_at,
    e.time_zone, e.capacity, e.reentry, e.hard_limit, e.note, e.expected, e.expected_at, ${expectedSql} AS live_expected, e.archived_at, e.updated_at, e.config_epoch,
    (SELECT json_group_array(template_id) FROM (${scopedEventTemplates} ORDER BY x.template_id)) AS template_ids,
    (SELECT json_group_array(template_id) FROM (
       SELECT x.template_id FROM scan_event_templates x WHERE x.event_id=e.id ORDER BY x.template_id
    )) AS stored_template_ids,
    ${templateReleaseHeadsSql(
      'SELECT template_id FROM scan_event_templates WHERE event_id=e.id',
      'e.org_id',
      'e.mode',
    )} AS release_heads,
    ${arrivedSql} AS arrived,
    (SELECT count(*) FROM scanners s WHERE s.event_id=e.id AND s.org_id=e.org_id
       AND s.mode=e.mode AND s.revoked_at IS NULL) AS scanners
  FROM ${from}scan_events e`;

export const SELECT_WITH_COUNT = eventSelect(eventExpectedCountSql('e', '?'), eventArrivedCountSql('e'));
const selectUnder = (auth: ScanReadAuthority) =>
  eventSelect(eventExpectedCountSql('e', '?'), eventArrivedCountSql('e'), auth.rows);

const toRow = (r: Raw): ConsoleEventRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  name: r.name,
  matchInput: r.match_input,
  matchValues: r.match_values ? (JSON.parse(r.match_values) as string[]) : null,
  opensAt: r.opens_at,
  closesAt: r.closes_at,
  timeZone: r.time_zone,
  capacity: r.capacity,
  reentry: r.reentry === 1,
  hardLimit: r.hard_limit === 1,
  note: r.note,
  expected: r.expected,
  expectedAt: r.expected_at,
  liveExpected: r.live_expected,
  archivedAt: r.archived_at,
  templateIds: r.template_ids ? (JSON.parse(r.template_ids) as string[]) : [],
  storedTemplateIds: r.stored_template_ids ? (JSON.parse(r.stored_template_ids) as string[]) : [],
  releaseHeads: r.release_heads,
  arrived: r.arrived,
  scanners: r.scanners,
  updatedAt: r.updated_at,
  configEpoch: r.config_epoch,
});

/** Look up only the owning scope before tenant authorization, not event relationships or counts. */
export async function getConsoleEventTarget(db: Db, id: string) {
  return first<{ orgId: string; mode: Mode }>(
    db,
    'SELECT org_id AS orgId, mode FROM scan_events WHERE id = ?',
    [id],
  );
}

/**
 * The event as committed, for the answer to a mutation that already succeeded: by id in the org,
 * with no session or keyset check that could turn a committed write into an error.
 */
export async function getCommittedConsoleEvent(
  db: Db,
  id: string,
  orgId: string,
  now: number,
): Promise<ConsoleEventRow | null> {
  const row = await first<Raw>(db, `${SELECT_WITH_COUNT} WHERE e.id = ? AND e.org_id = ?`, [
    now,
    id,
    orgId,
  ]);
  return row ? toRow(row) : null;
}

/** The events under the actor's tenant: `filter` follows the tenant term, `params` bind it after `now`. */
export const eventsStmt = (
  db: Db,
  auth: ScanReadAuthority,
  filter: string,
  params: SqlValue[],
  now: number,
) =>
  scanRead(
    db,
    auth,
    `${selectUnder(auth)} WHERE ${auth.tenantOnce('e', 'scan_events')}${filter}`,
    [now, ...params],
  );

/** Rows with their occupancy counts under one fence and filter, and whether the fence holds, in one batch. */
async function readEvents(
  db: Db,
  auth: ScanReadAuthority,
  filter: string,
  params: SqlValue[],
  now: number,
): Promise<{ authorized: boolean; rows: ConsoleEventRow[] }> {
  const [rows, status] = await db.batch([
    eventsStmt(db, auth, filter, params, now),
    scanAuthorizedStmt(db, auth),
  ]);
  return {
    authorized: (status?.results[0] as { authorized: number } | undefined)?.authorized === 1,
    rows: (rows?.results ?? []).map((r) => toRow(r as unknown as Raw)),
  };
}

/** The event and its counts under the actor's read authority, with whether the actor is allowed. */
export async function getAuthorizedConsoleEvent(
  db: Db,
  id: string,
  auth: ScanReadAuthority,
  now: number,
): Promise<{ authorized: boolean; row: ConsoleEventRow | null }> {
  const { authorized, rows } = await readEvents(db, auth, ' AND e.id=?', [id], now);
  return { authorized, row: rows[0] ?? null };
}

export interface EventFilter {
  status?: 'upcoming' | 'live' | 'ended' | 'archived' | undefined;
  q?: string | undefined;
  now: number;
  cursor?: string | undefined;
  limit: number;
}

/** Newest opening first. The tenant comes from the actor, so the list rides `scan_events_org`. */
export async function listConsoleEvents(
  db: Db,
  auth: ScanReadAuthority,
  f: EventFilter,
): Promise<{ authorized: boolean; rows: ConsoleEventRow[] }> {
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (f.status === 'archived') where.push('e.archived_at IS NOT NULL');
  else if (f.status) {
    where.push('e.archived_at IS NULL');
    if (f.status === 'upcoming') where.push('e.opens_at > ?');
    if (f.status === 'live') where.push('e.opens_at <= ? AND e.closes_at >= ?');
    if (f.status === 'ended') where.push('e.closes_at < ?');
    params.push(...(f.status === 'live' ? [f.now, f.now] : [f.now]));
  }
  if (f.q) {
    const match = prefixMatch('e.name', f.q);
    where.push(match.sql);
    params.push(...match.params);
  }
  if (f.cursor) {
    where.push(`(e.opens_at, e.id) < (
      SELECT c.opens_at, c.id FROM scan_events c WHERE c.id = ? AND ${auth.tenantOnce('c', 'scan_events')}
    )`);
    params.push(f.cursor);
  }
  const filter = where.map((w) => ` AND ${w}`).join('');
  return readEvents(
    db,
    auth,
    `${filter} ORDER BY e.opens_at DESC, e.id DESC LIMIT ?`,
    [...params, f.limit],
    f.now,
  );
}
