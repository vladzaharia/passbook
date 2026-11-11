import type { Mode } from '../../../shared/contracts/common.ts';
import { first, likeEscape, type SqlValue, stmt } from '../../platform/db.ts';
import { UnavailableError } from '../../platform/errors.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { eventExpectedCountSql } from './repo-counts.ts';
import { eventArrivedCountSql } from './repo-event-attendance.ts';
import type { EventAuthority } from './repo-event-keyset.ts';
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
) => `SELECT e.id, e.org_id, e.mode, e.name, e.match_input, e.match_values, e.opens_at, e.closes_at,
    e.time_zone, e.capacity, e.reentry, e.note, e.expected, e.expected_at, ${expectedSql} AS live_expected, e.archived_at, e.updated_at, e.config_epoch,
    (SELECT json_group_array(template_id) FROM (${scopedEventTemplates} ORDER BY x.template_id)) AS template_ids,
    (SELECT json_group_array(template_id) FROM (
       SELECT x.template_id FROM scan_event_templates x WHERE x.event_id=e.id ORDER BY x.template_id
    )) AS stored_template_ids,
    ${templateReleaseHeadsSql(
      'SELECT template_id FROM scan_event_templates WHERE event_id=e.id',
      'e.org_id',
      'e.mode',
    )} AS release_heads,
    ${eventArrivedCountSql('e')} AS arrived,
    (SELECT count(*) FROM scanners s WHERE s.event_id=e.id AND s.org_id=e.org_id
       AND s.mode=e.mode AND s.revoked_at IS NULL) AS scanners
  FROM scan_events e`;

const SELECT = eventSelect('NULL');
const SELECT_WITH_COUNT = eventSelect(eventExpectedCountSql('e', '?'));

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

export async function getConsoleEvent(
  db: Db,
  id: string,
  credentialKeysetCommitment: string,
): Promise<ConsoleEventRow | null> {
  const row = await first<Raw>(db, `${SELECT} WHERE e.id = ? AND ${credentialRefKeysetSql}`, [
    id,
    credentialKeysetCommitment,
  ]);
  return row ? toRow(row) : null;
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

/** Project the committed response in the same transaction and under the same tenant authority. */
export function authorizedEventStmt(
  db: Db,
  id: string,
  authority: EventAuthority,
  now: number,
  credentialKeysetCommitment: string,
): D1PreparedStatement {
  if (
    authority.kind !== 'session' ||
    (authority.capability !== 'scanning:read' && authority.capability !== 'scanning:manage')
  )
    return stmt(db, `${SELECT_WITH_COUNT} WHERE 0 AND ${credentialRefKeysetSql}`, [
      now,
      credentialKeysetCommitment,
    ]);
  return stmt(
    db,
    `${SELECT_WITH_COUNT} WHERE e.id=? AND e.mode=? AND ${tenantPassAuthoritySql(authority, 'e')}
      AND (${authority.csrfFence.sql}) AND ${credentialRefKeysetSql}`,
    [
      now,
      id,
      authority.mode,
      ...tenantPassAuthorityParams(authority, now),
      ...authority.csrfFence.params,
      credentialKeysetCommitment,
    ],
  );
}

export function consoleEventFromResult(result: D1Result): ConsoleEventRow | null {
  const row = result.results[0] as unknown as Raw | undefined;
  return row ? toRow(row) : null;
}

/** Empty results still carry session and keyset status from the projection's transaction. */
function eventReadStatusStmt(
  db: Db,
  authority: EventAuthority | undefined,
  now: number,
  credentialKeysetCommitment: string,
): D1PreparedStatement {
  const access = authority
    ? `${tenantPassAuthoritySql(authority)} AND (${authority.csrfFence.sql})`
    : '1';
  const params = authority
    ? [...tenantPassAuthorityParams(authority, now), ...authority.csrfFence.params]
    : [];
  return stmt(db, `SELECT (${access}) AS authority, ${credentialRefKeysetSql} AS keyset`, [
    ...params,
    credentialKeysetCommitment,
  ]);
}

function eventReadStatus(result: D1Result | undefined): boolean {
  const state = result?.results[0] as { authority: number; keyset: number } | undefined;
  if (state?.authority !== 1) return false;
  if (state.keyset !== 1)
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  return true;
}

/** Bind the exact tenant session to the event and its relationship counts in one read. */
export async function getAuthorizedConsoleEvent(
  db: Db,
  id: string,
  authority: EventAuthority,
  now: number,
  credentialKeysetCommitment: string,
): Promise<ConsoleEventRow | null> {
  if (
    authority.kind !== 'session' ||
    (authority.capability !== 'scanning:read' && authority.capability !== 'scanning:manage')
  )
    return null;
  const [projection, status] = await db.batch([
    authorizedEventStmt(db, id, authority, now, credentialKeysetCommitment),
    eventReadStatusStmt(db, authority, now, credentialKeysetCommitment),
  ]);
  return eventReadStatus(status) && projection ? consoleEventFromResult(projection) : null;
}

export interface EventFilter {
  mode: Mode;
  orgId?: string | undefined;
  status?: 'upcoming' | 'live' | 'ended' | 'archived' | undefined;
  q?: string | undefined;
  now: number;
  cursor?: string | undefined;
  limit: number;
  credentialKeysetCommitment: string;
  authority?: EventAuthority | undefined;
}

/** Newest opening first. An org list rides `scan_events_org`. */
export async function listConsoleEvents(db: Db, f: EventFilter): Promise<ConsoleEventRow[]> {
  const where = ['e.mode = ?', credentialRefKeysetSql];
  const params: SqlValue[] = [f.mode, f.credentialKeysetCommitment];
  if (f.orgId) {
    where.push('e.org_id = ?');
    params.push(f.orgId);
  }
  if (f.authority) {
    if (
      f.authority.kind !== 'session' ||
      f.orgId !== f.authority.orgId ||
      f.mode !== f.authority.mode ||
      (f.authority.capability !== 'scanning:read' && f.authority.capability !== 'scanning:manage')
    )
      return [];
    where.push(`${tenantPassAuthoritySql(f.authority, 'e')} AND (${f.authority.csrfFence.sql})`);
    params.push(...tenantPassAuthorityParams(f.authority, f.now), ...f.authority.csrfFence.params);
  }
  if (f.status === 'archived') where.push('e.archived_at IS NOT NULL');
  else if (f.status) {
    where.push('e.archived_at IS NULL');
    if (f.status === 'upcoming') where.push('e.opens_at > ?');
    if (f.status === 'live') where.push('e.opens_at <= ? AND e.closes_at >= ?');
    if (f.status === 'ended') where.push('e.closes_at < ?');
    params.push(...(f.status === 'live' ? [f.now, f.now] : [f.now]));
  }
  if (f.q) {
    where.push("e.name LIKE ? ESCAPE '\\'");
    params.push(`${likeEscape(f.q)}%`);
  }
  if (f.cursor) {
    where.push(`(e.opens_at, e.id) < (
      SELECT opens_at, id FROM scan_events WHERE id = ? AND mode = ?${f.orgId ? ' AND org_id = ?' : ''}
    )`);
    params.push(f.cursor, f.mode, ...(f.orgId ? [f.orgId] : []));
  }
  const [page, status] = await db.batch([
    stmt(
      db,
      `${SELECT_WITH_COUNT} WHERE ${where.join(' AND ')} ORDER BY e.opens_at DESC, e.id DESC LIMIT ?`,
      [f.now, ...params, f.limit],
    ),
    eventReadStatusStmt(db, f.authority, f.now, f.credentialKeysetCommitment),
  ]);
  if (!eventReadStatus(status)) return [];
  return (page?.results ?? []).map((row) => toRow(row as unknown as Raw));
}
