import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';
import { knownEmailSql } from '../../platform/known-email-sql.ts';

export interface VisitorRow {
  id: string;
  orgId: string;
  mode: Mode;
  passId: string;
  name: string;
  hostName: string;
  hostEmail: string;
  windowFrom: number;
  windowUntil: number;
  note: string | null;
  /** The pass was voided or removed, or the visit cancelled. */
  cancelled: boolean;
  hasEmail: boolean;
  arrivedAt: number | null;
  lastInAt: number | null;
  /** The later of the recorded departure and the latest exit scan. */
  lastOutAt: number | null;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  pass_id: string;
  name: string;
  host_name: string;
  host_email: string;
  window_from: number;
  window_until: number;
  note: string | null;
  cancelled: number;
  has_email: number;
  arrived_at: number | null;
  last_in_at: number | null;
  last_out_at: number | null;
}

const SCAN = `FROM scans s WHERE s.pass_id = v.pass_id AND s.org_id = v.org_id AND s.mode = v.mode
  AND s.state = 'done' AND s.outcome = 'ok' AND s.undone_by IS NULL`;
const IN = `AND s.action_kind = 'check_in' AND (s.direction IS NULL OR s.direction = 'in')`;

const SELECT = `SELECT v.id, v.org_id, v.mode, v.pass_id, v.name, v.host_name, v.host_email, v.window_from,
  v.window_until, v.note,
  (v.cancelled_at IS NOT NULL OR p.status = 'voided' OR p.removed_at IS NOT NULL OR p.deleted_at IS NOT NULL) AS cancelled,
  (p.holder_email IS NOT NULL) AS has_email,
  (SELECT MIN(s.at) ${SCAN} ${IN}) AS arrived_at,
  (SELECT MAX(s.at) ${SCAN} ${IN}) AS last_in_at,
  MAX(COALESCE(v.left_at, 0), COALESCE((SELECT MAX(s.at) ${SCAN} AND s.direction = 'out'), 0)) AS last_out_at
  FROM visitors v JOIN passes p ON p.id = v.pass_id AND p.org_id = v.org_id AND p.mode = v.mode`;

const toRow = (r: Raw): VisitorRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  passId: r.pass_id,
  name: r.name,
  hostName: r.host_name,
  hostEmail: r.host_email,
  windowFrom: r.window_from,
  windowUntil: r.window_until,
  note: r.note,
  cancelled: r.cancelled === 1,
  hasEmail: r.has_email === 1,
  arrivedAt: r.arrived_at,
  lastInAt: r.last_in_at,
  lastOutAt: r.last_out_at === 0 ? null : r.last_out_at,
});

export type VisitTab = 'today' | 'upcoming' | 'past';

/** One org and mode's visits for a tab: `day` bounds the viewer's day. */
export async function listVisitors(
  db: D1Database,
  orgId: string,
  mode: Mode,
  tab: VisitTab,
  day: { start: number; end: number },
  templateIds?: readonly string[],
): Promise<VisitorRow[]> {
  const t = {
    today: {
      where: 'v.window_until >= ? AND v.window_from < ?',
      by: [day.start, day.end],
      dir: 'ASC',
    },
    upcoming: { where: 'v.window_from >= ?', by: [day.end], dir: 'ASC' },
    past: { where: 'v.window_until < ?', by: [day.start], dir: 'DESC' },
  }[tab];
  const rows = await all<Raw>(
    db,
    `${SELECT} WHERE v.org_id = ? AND v.mode = ? AND ${t.where}${
      templateIds ? ' AND p.template_id IN (SELECT value FROM json_each(?))' : ''
    }
     ORDER BY v.window_from ${t.dir}, v.id LIMIT 200`,
    [orgId, mode, ...t.by, ...(templateIds ? [JSON.stringify(templateIds)] : [])],
  );
  return rows.map(toRow);
}

export async function visitorById(
  db: D1Database,
  orgId: string,
  mode: Mode,
  id: string,
): Promise<VisitorRow | null> {
  const r = await first<Raw>(db, `${SELECT} WHERE v.id = ? AND v.org_id = ? AND v.mode = ?`, [
    id,
    orgId,
    mode,
  ]);
  return r ? toRow(r) : null;
}

export async function visitorByPass(
  db: D1Database,
  orgId: string,
  mode: Mode,
  passId: string,
): Promise<VisitorRow | null> {
  const r = await first<Raw>(db, `${SELECT} WHERE v.pass_id = ? AND v.org_id = ? AND v.mode = ?`, [
    passId,
    orgId,
    mode,
  ]);
  return r ? toRow(r) : null;
}

/** The org and pass a finished scan belongs to; the arrival notice starts from here. */
export async function scanTarget(
  db: D1Database,
  scanId: string,
): Promise<{ orgId: string; mode: Mode; passId: string; at: number } | null> {
  const r = await first<{ org_id: string; mode: Mode; pass_id: string; at: number }>(
    db,
    `SELECT org_id, mode, pass_id, at FROM scans
     WHERE id = ? AND state = 'done' AND outcome = 'ok' AND pass_id IS NOT NULL`,
    [scanId],
  );
  return r ? { orgId: r.org_id, mode: r.mode, passId: r.pass_id, at: r.at } : null;
}

export interface TemplateCandidate {
  id: string;
  name: string;
  manifest: string;
}

/** Active templates of the org, newest first, with the manifest of the active version. */
export function orgTemplates(db: D1Database, orgId: string): Promise<TemplateCandidate[]> {
  return all<TemplateCandidate>(
    db,
    `SELECT t.id, t.name, v.manifest FROM templates t
     JOIN template_versions v ON v.template_id = t.id AND v.version = t.active_version
     WHERE t.org_id = ? AND t.status = 'active' ORDER BY t.created_at DESC LIMIT 50`,
    [orgId],
  );
}

/** The tracked places (zones, events) a pass is in now. */
export async function insidePlaces(
  db: D1Database,
  orgId: string,
  passId: string,
): Promise<string[]> {
  const rows = await all<{ scope: string }>(
    db,
    `SELECT scope FROM scan_presence
     WHERE pass_id = ? AND org_id = ? AND state = 'in' AND (scope LIKE 'zone:%' OR scope LIKE 'event:%')`,
    [passId, orgId],
  );
  return rows.map((r) => r.scope);
}

export interface OffboardPass {
  id: string;
  who: string;
  voided: boolean;
}

/** Live passes of a person, named by holder email or by external ID, in one org and mode. */
export async function offboardPasses(
  db: D1Database,
  orgId: string,
  mode: Mode,
  by: { email: string } | { externalId: string },
): Promise<OffboardPass[]> {
  const [column, value] =
    'email' in by ? ['holder_email', by.email] : ['external_id', by.externalId];
  const rows = await all<{ id: string; who: string | null; status: string }>(
    db,
    `SELECT id, COALESCE(owner_user_id, holder_email, id) AS who, status FROM passes
     WHERE org_id = ? AND mode = ? AND ${column} = ? AND removed_at IS NULL AND deleted_at IS NULL
     ORDER BY id LIMIT 500`,
    [orgId, mode, value],
  );
  return rows.map((r) => ({ id: r.id, who: r.who ?? r.id, voided: r.status === 'voided' }));
}

/** Tag bindings still active on these passes. */
export async function activeBindingsOn(
  db: D1Database,
  passIds: string[],
): Promise<{ id: string; tagId: string }[]> {
  if (passIds.length === 0) return [];
  const rows = await all<{ id: string; tag_id: string }>(
    db,
    `SELECT id, tag_id FROM tag_bindings
     WHERE ended_at IS NULL AND pass_id IN (${passIds.map(() => '?').join(',')})`,
    passIds,
  );
  return rows.map((r) => ({ id: r.id, tagId: r.tag_id }));
}

export interface HostChoice {
  id: string;
  name: string;
  email: string;
}

const HOSTS = `SELECT u.id AS id, u.name AS name, ${knownEmailSql('u.primary_email')} AS email FROM org_memberships m
  JOIN users u ON u.id = m.user_id
  WHERE m.org_id = ? AND m.revoked_at IS NULL AND ${knownEmailSql('u.primary_email')} IS NOT NULL`;
const toHost = (r: { id: string; name: string | null; email: string }): HostChoice => ({
  id: r.id,
  // An email is never shown as a name: /hosts is open to callers who may not see member emails.
  name: r.name?.trim() || 'Member',
  email: r.email,
});

/** Members of the org with a verified email: who a visitor may be hosted by. */
export async function hostChoices(db: D1Database, orgId: string): Promise<HostChoice[]> {
  const rows = await all<{ id: string; name: string | null; email: string }>(
    db,
    `${HOSTS} ORDER BY COALESCE(u.name, u.primary_email) LIMIT 200`,
    [orgId],
  );
  return rows.map(toHost);
}

export async function hostById(
  db: D1Database,
  orgId: string,
  userId: string,
): Promise<HostChoice | null> {
  const r = await first<{ id: string; name: string | null; email: string }>(
    db,
    `${HOSTS} AND u.id = ?`,
    [orgId, userId],
  );
  return r ? toHost(r) : null;
}
