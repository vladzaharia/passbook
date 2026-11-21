import type { Mode } from '../../../shared/contracts/common.ts';
import { all } from '../../platform/db.ts';
import { templateVisibleSql, visibleBinds } from '../templates/repo-visibility.ts';
import type { TakenNames } from './setup-names.ts';

type Db = D1Database;

const names = async (db: Db, sql: string, binds: string[]): Promise<TakenNames> =>
  new Set((await all<{ name: string }>(db, sql, binds)).map((r) => r.name.toLowerCase()));

/** Live scanner names of the org and mode (unique index `scanners_org_name`). */
export const takenScannerNames = (db: Db, orgId: string, mode: Mode) =>
  names(db, 'SELECT name FROM scanners WHERE org_id = ? AND mode = ? AND revoked_at IS NULL', [
    orgId,
    mode,
  ]);

/** Active zone names of the org (`scan_zones_org_name`). */
export const takenZoneNames = (db: Db, orgId: string) =>
  names(db, 'SELECT name FROM scan_zones WHERE org_id = ? AND archived_at IS NULL', [orgId]);

/** Active staff names of the org (`scan_staff_org_name`). */
export const takenStaffNames = (db: Db, orgId: string) =>
  names(db, 'SELECT name FROM scan_staff WHERE org_id = ? AND disabled_at IS NULL', [orgId]);

export interface TemplateRow {
  id: string;
  name: string;
  manifest: string;
}

/** The active, non-blueprint templates the org may see among `ids`, with their active manifest. */
export const visibleTemplates = (db: Db, orgId: string, ids: string[]) =>
  all<TemplateRow>(
    db,
    `SELECT t.id AS id, t.name AS name, tv.manifest AS manifest FROM templates t
     JOIN template_versions tv ON tv.template_id = t.id AND tv.version = t.active_version
     WHERE ${templateVisibleSql('t', '?')} AND t.status = 'active' AND t.blueprint = 0
       AND t.id IN (SELECT value FROM json_each(?))`,
    [...visibleBinds(orgId), JSON.stringify(ids)],
  );

/** Live passes per template and mode. */
export const issuedCounts = (db: Db, orgId: string, ids: string[]) =>
  all<{ template_id: string; mode: Mode; n: number }>(
    db,
    `SELECT template_id, mode, COUNT(*) AS n FROM passes
     WHERE org_id = ? AND status = 'active' AND deleted_at IS NULL AND removed_at IS NULL
       AND template_id IN (SELECT value FROM json_each(?)) GROUP BY template_id, mode`,
    [orgId, JSON.stringify(ids)],
  );

export const liveEvents = (db: Db, orgId: string, mode: Mode, ids: string[]) =>
  all<{ id: string; name: string; reentry: number; capacity: number | null }>(
    db,
    `SELECT id, name, reentry, capacity FROM scan_events
     WHERE org_id = ? AND mode = ? AND archived_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
    [orgId, mode, JSON.stringify(ids)],
  );

export const eventTemplateLinks = (db: Db, ids: string[]) =>
  all<{ event_id: string; template_id: string }>(
    db,
    'SELECT event_id, template_id FROM scan_event_templates WHERE event_id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(ids)],
  );

export const activeStaff = (db: Db, orgId: string) =>
  all<{ id: string; role: 'door' | 'desk' | 'manager' }>(
    db,
    'SELECT id, role FROM scan_staff WHERE org_id = ? AND disabled_at IS NULL LIMIT 1000',
    [orgId],
  );

/** Devices never paired whose pairing code has run out (or was never issued). */
export const unpairedExpired = (db: Db, orgId: string, ids: string[], now: number) =>
  all<{ id: string }>(
    db,
    `SELECT id FROM scanners WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))
       AND revoked_at IS NULL AND token_hash IS NULL AND (pair_expires_at IS NULL OR pair_expires_at <= ?)`,
    [orgId, JSON.stringify(ids), now],
  );
