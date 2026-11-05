import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, likeEscape, placeholders, stmt } from '../../platform/db.ts';
import { redactDetail } from '../audit/redact.ts';
import type { AuditEntry } from '../audit/types.ts';

type Db = D1Database;

/** A `scanners` row as the console reads it (the device side is `ScannerRow` in repo-device.ts). */
export interface ConsoleScannerRow {
  id: string;
  orgId: string;
  mode: Mode;
  kind: 'device' | 'terminal' | 'display';
  deviceRole: 'scan' | 'customer' | 'monitor';
  name: string;
  eventId: string | null;
  settings: string;
  timeZone: string;
  hasToken: boolean;
  pairedAt: number | null;
  pairedLabel: string | null;
  expiresAt: number | null;
  lastSeenAt: number | null;
  revokedAt: number | null;
  staffId: string | null;
  staffName: string | null;
  staffSince: number | null;
  staffSeenAt: number | null;
  pairExpiresAt: number | null;
  hasPairCode: boolean;
  templateIds: string[];
  createdAt: number;
  updatedAt: number;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  kind: ConsoleScannerRow['kind'];
  device_role: ConsoleScannerRow['deviceRole'];
  name: string;
  event_id: string | null;
  settings: string;
  time_zone: string;
  has_token: number;
  paired_at: number | null;
  paired_label: string | null;
  expires_at: number | null;
  last_seen_at: number | null;
  revoked_at: number | null;
  staff_id: string | null;
  staff_name: string | null;
  staff_since: number | null;
  staff_seen_at: number | null;
  pair_expires_at: number | null;
  has_pair_code: number;
  template_ids: string | null;
  created_at: number;
  updated_at: number;
}

const SELECT = `SELECT s.id, s.org_id, s.mode, s.kind, s.device_role, s.name, s.event_id, s.settings, s.time_zone,
    s.token_hash IS NOT NULL AS has_token, s.paired_at, s.paired_label, s.expires_at, s.last_seen_at,
    s.revoked_at, s.staff_id, st.name AS staff_name, s.staff_since, s.staff_seen_at, s.pair_expires_at,
    s.pair_code_hash IS NOT NULL AS has_pair_code, s.created_at, s.updated_at,
    (SELECT group_concat(x.template_id) FROM scanner_templates x
       JOIN templates t ON t.id = x.template_id AND t.status != 'deleted'
       WHERE x.scanner_id = s.id) AS template_ids
  FROM scanners s LEFT JOIN scan_staff st ON st.id = s.staff_id`;

const toRow = (r: Raw): ConsoleScannerRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  kind: r.kind,
  deviceRole: r.device_role,
  name: r.name,
  eventId: r.event_id,
  settings: r.settings,
  timeZone: r.time_zone,
  hasToken: r.has_token === 1,
  pairedAt: r.paired_at,
  pairedLabel: r.paired_label,
  expiresAt: r.expires_at,
  lastSeenAt: r.last_seen_at,
  revokedAt: r.revoked_at,
  staffId: r.staff_id,
  staffName: r.staff_name,
  staffSince: r.staff_since,
  staffSeenAt: r.staff_seen_at,
  pairExpiresAt: r.pair_expires_at,
  hasPairCode: r.has_pair_code === 1,
  templateIds: r.template_ids ? r.template_ids.split(',').sort() : [],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function getConsoleScanner(db: Db, id: string): Promise<ConsoleScannerRow | null> {
  const row = await first<Raw>(db, `${SELECT} WHERE s.id = ?`, [id]);
  return row ? toRow(row) : null;
}

export interface ScannerFilter {
  mode: Mode;
  orgId?: string | undefined;
  status?: 'not_paired' | 'paired' | 'revoked' | undefined;
  eventId?: string | undefined;
  q?: string | undefined;
  /** The last id of the previous page. */
  cursor?: string | undefined;
  limit: number;
}

const STATUS_SQL = {
  not_paired: 's.token_hash IS NULL AND s.revoked_at IS NULL',
  paired: 's.token_hash IS NOT NULL AND s.revoked_at IS NULL',
  revoked: 's.revoked_at IS NOT NULL',
} as const;

/** Newest first (UUIDv7 ids). An org list rides `scanners_org`. */
export async function listConsoleScanners(db: Db, f: ScannerFilter): Promise<ConsoleScannerRow[]> {
  const where = ['s.mode = ?'];
  const params: (string | number)[] = [f.mode];
  if (f.orgId) {
    where.push('s.org_id = ?');
    params.push(f.orgId);
  }
  if (f.eventId) {
    where.push('s.event_id = ?');
    params.push(f.eventId);
  }
  if (f.status) where.push(STATUS_SQL[f.status]);
  if (f.q) {
    where.push("s.name LIKE ? ESCAPE '\\'");
    params.push(`${likeEscape(f.q)}%`);
  }
  if (f.cursor) {
    where.push('s.id < ?');
    params.push(f.cursor);
  }
  const rows = await all<Raw>(
    db,
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT ?`,
    [...params, f.limit],
  );
  return rows.map(toRow);
}

/** `ok` scans since each scanner's local midnight, one batch. */
export async function countToday(
  db: Db,
  items: readonly { id: string; since: number }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < items.length; i += 50) {
    const slice = items.slice(i, i + 50);
    const results = await db.batch(
      slice.map((item) =>
        stmt(
          db,
          `SELECT count(*) AS n FROM scans
           WHERE scanner_id = ? AND at >= ? AND outcome = 'ok' AND undone_at IS NULL AND action_kind != 'undo'`,
          [item.id, item.since],
        ),
      ),
    );
    for (const [at, item] of slice.entries())
      out.set(item.id, (results[at]?.results[0] as { n: number } | undefined)?.n ?? 0);
  }
  return out;
}

export interface NewScanner {
  id: string;
  orgId: string;
  mode: Mode;
  kind: 'device' | 'terminal';
  name: string;
  eventId: string | null;
  settings: string;
  timeZone: string;
  expiresAt: number | null;
  createdBy: string;
  now: number;
}

export const insertScannerStmt = (db: Db, s: NewScanner): D1PreparedStatement =>
  stmt(
    db,
    `INSERT INTO scanners (id, org_id, mode, kind, device_role, name, event_id, settings, time_zone, expires_at,
       created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'scan', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.id,
      s.orgId,
      s.mode,
      s.kind,
      s.name,
      s.eventId,
      s.settings,
      s.timeZone,
      s.expiresAt,
      s.createdBy,
      s.now,
      s.now,
    ],
  );

export const addTemplatesStmts = (
  db: Db,
  scannerId: string,
  templateIds: readonly string[],
): D1PreparedStatement[] =>
  templateIds.map((id) =>
    stmt(db, 'INSERT INTO scanner_templates (scanner_id, template_id) VALUES (?, ?)', [
      scannerId,
      id,
    ]),
  );

export const replaceTemplatesStmts = (
  db: Db,
  scannerId: string,
  templateIds: readonly string[],
): D1PreparedStatement[] => [
  stmt(db, 'DELETE FROM scanner_templates WHERE scanner_id = ?', [scannerId]),
  ...addTemplatesStmts(db, scannerId, templateIds),
];

export interface ScannerPatch {
  name?: string;
  settings?: string;
  /** `null` detaches, a string attaches, undefined leaves it. */
  eventId?: string | null;
  timeZone?: string;
}

/** Bumps `updated_at`, which is the scanner's `configRev`. */
export function updateScannerStmt(
  db: Db,
  id: string,
  patch: ScannerPatch,
  now: number,
): D1PreparedStatement {
  const sets = ['updated_at = ?'];
  const params: (string | number | null)[] = [now];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.settings !== undefined) {
    sets.push('settings = ?');
    params.push(patch.settings);
  }
  if (patch.eventId !== undefined) {
    sets.push('event_id = ?');
    params.push(patch.eventId);
  }
  if (patch.timeZone !== undefined) {
    sets.push('time_zone = ?');
    params.push(patch.timeZone);
  }
  return stmt(db, `UPDATE scanners SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

export const setModeStmt = (
  db: Db,
  id: string,
  mode: Mode,
  detach: boolean,
  now: number,
): D1PreparedStatement =>
  stmt(
    db,
    `UPDATE scanners SET mode = ?, ${detach ? 'event_id = NULL, ' : ''}updated_at = ? WHERE id = ?`,
    [mode, now, id],
  );

/** Revoking keeps the token columns, so the old device hears SCANNER_REVOKED. A pending code dies too. */
export const revokeStmt = (db: Db, id: string, now: number): D1PreparedStatement =>
  stmt(
    db,
    `UPDATE scanners SET revoked_at = ?, updated_at = ?, pair_code_hash = NULL, pair_expires_at = NULL,
       staff_id = NULL, staff_since = NULL, staff_seen_at = NULL
     WHERE id = ? AND revoked_at IS NULL`,
    [now, now, id],
  );

export const setPairCodeStmt = (
  db: Db,
  id: string,
  hash: string,
  expiresAt: number,
  userId: string,
  now: number,
): D1PreparedStatement =>
  stmt(
    db,
    `UPDATE scanners SET pair_code_hash = ?, pair_expires_at = ?, pair_created_by = ?, updated_at = ?
     WHERE id = ?`,
    [hash, expiresAt, userId, now, id],
  );

export interface Credential {
  tokenPrefix: string;
  tokenHash: string;
  /** Null for a terminal. */
  csrfSecret: string | null;
  label: string | null;
  expiresAt: number;
  now: number;
}

/**
 * Installs a credential over the old one (the old token stops matching now), reactivates a revoked
 * scanner and ends any staff binding. Consumes a pairing code when `codeHash` is given, and then
 * only if it is unexpired. Returns a row only when it applied, so a concurrent loser gets none.
 */
export function installCredentialStmt(
  db: Db,
  id: string,
  c: Credential,
  codeHash: string | null,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE scanners SET token_prefix = ?, token_hash = ?, csrf_secret = ?, paired_at = ?, paired_label = ?,
       expires_at = ?, last_seen_at = ?, revoked_at = NULL, updated_at = ?,
       staff_id = NULL, staff_since = NULL, staff_seen_at = NULL,
       pair_code_hash = NULL
     WHERE id = ? AND kind != 'display' ${codeHash ? 'AND pair_code_hash = ? AND pair_expires_at > ?' : ''}
     RETURNING id`,
    [
      c.tokenPrefix,
      c.tokenHash,
      c.csrfSecret,
      c.now,
      c.label,
      c.expiresAt,
      c.now,
      c.now,
      id,
      ...(codeHash ? [codeHash, c.now] : []),
    ],
  );
}

/** An audit row that lands only while the scanner holds this token hash: a pairing's winner, an unpair. */
export function heldAuditStmt(
  db: Db,
  ctx: { clock: { now(): number }; requestId: string | null },
  entry: AuditEntry,
  tokenHash: string,
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM scanners WHERE id = ? AND token_hash = ?)`,
    [
      ctx.clock.now(),
      entry.orgId ?? null,
      entry.actorType,
      entry.actorId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      ctx.requestId,
      entry.ipPrefix ?? null,
      entry.detail ? JSON.stringify(redactDetail(entry.detail)) : null,
      entry.targetId ?? null,
      tokenHash,
    ],
  );
}

export interface PairTarget {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  orgName: string;
}

/** A live code of an active org. The same row answers preview and pair. */
export const findByPairCode = (db: Db, hash: string, now: number): Promise<PairTarget | null> =>
  first<{ id: string; org_id: string; mode: Mode; name: string; org_name: string }>(
    db,
    `SELECT s.id, s.org_id, s.mode, s.name, o.name AS org_name
     FROM scanners s JOIN orgs o ON o.id = s.org_id AND o.status = 'active'
     WHERE s.pair_code_hash = ? AND s.pair_expires_at > ? AND s.kind != 'display'`,
    [hash, now],
  ).then((r) =>
    r ? { id: r.id, orgId: r.org_id, mode: r.mode, name: r.name, orgName: r.org_name } : null,
  );

/** Clears the token of a device that unpaired itself. Matches only the token it presented. */
export const clearTokenStmt = (
  db: Db,
  id: string,
  tokenHash: string,
  now: number,
): D1PreparedStatement =>
  stmt(
    db,
    `UPDATE scanners SET token_prefix = NULL, token_hash = NULL, csrf_secret = NULL, paired_at = NULL,
       paired_label = NULL, expires_at = NULL, updated_at = ?,
       staff_id = NULL, staff_since = NULL, staff_seen_at = NULL
     WHERE id = ? AND token_hash = ? AND kind = 'device'
     RETURNING id, org_id`,
    [now, id, tokenHash],
  );

export const eventModeOf = (db: Db, orgId: string, id: string) =>
  first<{ mode: Mode; archived_at: number | null }>(
    db,
    'SELECT mode, archived_at FROM scan_events WHERE id = ? AND org_id = ?',
    [id, orgId],
  );

/** The first accepted template's id and sample inputs, for a test scanner's sample pass. */
export const firstTemplateManifest = (db: Db, orgId: string, ids: readonly string[]) =>
  first<{ id: string; manifest: string }>(
    db,
    `SELECT t.id, v.manifest FROM templates t
     JOIN template_versions v ON v.template_id = t.id AND v.version = t.active_version
     WHERE t.org_id = ? AND t.status = 'active' AND t.id IN (${placeholders(ids.length)})
     ORDER BY t.id LIMIT 1`,
    [orgId, ...ids],
  );
