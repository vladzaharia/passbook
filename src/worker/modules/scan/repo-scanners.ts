import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { maxNow, type SetValue } from '../../platform/authority-expr.ts';
import { all, first, placeholders, prefixMatch, stmt } from '../../platform/db.ts';

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
  /** Trigger-owned: what an edit derived from this row is checked against at commit. */
  configEpoch: number;
  credentialEpoch: number;
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
  config_epoch: number;
  credential_epoch: number;
}

const SELECT = `SELECT s.id, s.org_id, s.mode, s.kind, s.device_role, s.name, s.event_id, s.settings, s.time_zone,
    s.token_hash IS NOT NULL AS has_token, s.paired_at, s.paired_label, s.expires_at, s.last_seen_at,
    s.revoked_at, s.staff_id, st.name AS staff_name, s.staff_since, s.staff_seen_at, s.pair_expires_at,
    s.pair_code_hash IS NOT NULL AS has_pair_code, s.created_at, s.updated_at,
    s.config_epoch, s.credential_epoch,
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
  configEpoch: r.config_epoch,
  credentialEpoch: r.credential_epoch,
});

/** `mode` limits the read to the console's mode; a row of the other mode is absent. */
export async function getConsoleScanner(
  db: Db,
  id: string,
  mode?: Mode,
): Promise<ConsoleScannerRow | null> {
  const row = mode
    ? await first<Raw>(db, `${SELECT} WHERE s.id = ? AND s.mode = ?`, [id, mode])
    : await first<Raw>(db, `${SELECT} WHERE s.id = ?`, [id]);
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
    const match = prefixMatch('s.name', f.q);
    where.push(match.sql);
    params.push(...match.params);
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
  kind: 'device' | 'terminal' | 'display';
  deviceRole?: 'scan' | 'customer' | 'monitor';
  name: string;
  eventId: string | null;
  settings: string;
  timeZone: string;
  expiresAt: number | null;
  createdBy: string;
  now: number;
}

/** org_id and mode come from the grant row. */
export const addScannerInsert = (g: Grant, s: NewScanner): GrantedStatement =>
  g.insertSelect(
    'scanners',
    [
      'id',
      'kind',
      'device_role',
      'name',
      'event_id',
      'settings',
      'time_zone',
      'expires_at',
      'created_by',
      'created_at',
      'updated_at',
    ],
    [
      s.id,
      s.kind,
      s.deviceRole ?? 'scan',
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

export interface ScannerPatch {
  name?: string;
  settings?: string;
  /** `null` detaches, a string attaches, undefined leaves it. */
  eventId?: string | null;
  timeZone?: string;
}

/** Exactly one scanner of the grant's org is edited, or the batch aborts. */
export function addScannerPatch(
  g: Grant,
  id: string,
  patch: ScannerPatch,
  now: number,
): GrantedStatement {
  const set: Record<string, SetValue> = { updated_at: maxNow(now) };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.settings !== undefined) set.settings = patch.settings;
  if (patch.eventId !== undefined) set.event_id = patch.eventId;
  if (patch.timeZone !== undefined) set.time_zone = patch.timeZone;
  return g.update('scanners', { set, where: { id }, require: 'one' });
}

/** The mode move is the one write that sets `mode`; the new value is validated input, not a tenant. */
export const addScannerMode = (
  g: Grant,
  id: string,
  moveTo: Mode,
  detach: boolean,
  now: number,
  settings?: string,
): GrantedStatement =>
  g.update('scanners', {
    set: {
      mode: moveTo,
      ...(detach ? { event_id: null } : {}),
      ...(settings === undefined ? {} : { settings }),
      updated_at: maxNow(now),
    },
    where: { id },
    require: 'one',
  });

/** Revoking keeps the token columns, so the old device hears SCANNER_REVOKED. A pending code dies too. */
export const addScannerRevoke = (g: Grant, id: string, now: number): GrantedStatement =>
  g.update('scanners', {
    set: {
      revoked_at: now,
      updated_at: maxNow(now),
      pair_code_hash: null,
      pair_expires_at: null,
      staff_id: null,
      staff_since: null,
      staff_seen_at: null,
    },
    where: { id, revoked_at: null },
    require: 'one',
  });

export const eventModeOf = (db: Db, orgId: string, id: string) =>
  first<{ mode: Mode; archived_at: number | null }>(
    db,
    'SELECT mode, archived_at FROM scan_events WHERE id = ? AND org_id = ?',
    [id, orgId],
  );

/** The first accepted active template; its release determines the version used for a sample. */
export const firstSampleTemplate = (db: Db, orgId: string, ids: readonly string[]) =>
  first<{ id: string }>(
    db,
    `SELECT t.id FROM templates t
     WHERE (t.org_id = ? OR t.org_id IS NULL) AND t.status = 'active' AND t.id IN (${placeholders(ids.length)})
     ORDER BY t.id LIMIT 1`,
    [orgId, ...ids],
  );
