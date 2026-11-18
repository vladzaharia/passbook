import {
  DATA_CLASSES,
  RETENTION_CLASSES,
  type RetentionClass,
} from '../../../shared/privacy/data-classes.ts';
import { all, first } from '../../platform/db.ts';
import { knownEmailSql } from '../../platform/known-email-sql.ts';
import type { ActiveFloor, OrgRow, Raw } from './policy.ts';

/** A stored value that is not JSON: never a valid number of days, so it skips rather than defaults. */
export const UNPARSEABLE: unique symbol = Symbol('unparseable');

export function parseStored(text: string): Raw {
  try {
    return JSON.parse(text);
  } catch {
    return UNPARSEABLE;
  }
}

const KEYS = RETENTION_CLASSES.flatMap((c) => [DATA_CLASSES[c].key, DATA_CLASSES[c].maxKey]);
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Stored platform retention values by key; an absent key is not in the map. */
export async function readPlatformRaw(db: D1Database): Promise<Map<string, Raw>> {
  const rows = await all<{ key: string; value: string }>(
    db,
    `SELECT key, value FROM settings WHERE scope = 'platform' AND key IN (${marks(KEYS.length)})`,
    KEYS,
  );
  return new Map(rows.map((r) => [r.key, parseStored(r.value)]));
}

/**
 * Every org that has its own value, an unexpired floor or an org-wide hold for the class. Suspended and
 * soft-deleted orgs stay in: their own values, floors and holds still bind until the rows are purged.
 */
export async function readOrgRows(
  db: D1Database,
  cls: RetentionClass,
  now: number,
): Promise<OrgRow[]> {
  const key = DATA_CLASSES[cls].key;
  const [own, floors, holds] = await Promise.all([
    all<{ org_id: string; value: string }>(
      db,
      `SELECT substr(s.scope, 5) AS org_id, s.value FROM settings s
       JOIN orgs o ON o.id = substr(s.scope, 5) 
       WHERE s.key = ? AND s.scope GLOB 'org:*'`,
      [key],
    ),
    all<{ org_id: string; days: number; until: number }>(
      db,
      `SELECT f.org_id, f.days, f.until FROM retention_floors f
       JOIN orgs o ON o.id = f.org_id 
       WHERE f.class = ? AND f.until > ?`,
      [cls, now],
    ),
    all<{ org_id: string }>(
      db,
      `SELECT DISTINCT h.org_id FROM retention_holds h
       JOIN orgs o ON o.id = h.org_id 
       WHERE h.pass_id IS NULL AND h.released_at IS NULL`,
    ),
  ]);
  const byOrg = new Map<string, OrgRow>();
  const row = (orgId: string): OrgRow => {
    const hit = byOrg.get(orgId) ?? { orgId, raw: undefined, floor: null, held: false };
    byOrg.set(orgId, hit);
    return hit;
  };
  for (const r of own) row(r.org_id).raw = parseStored(r.value);
  for (const r of floors) row(r.org_id).floor = { days: r.days, until: r.until };
  for (const r of holds) row(r.org_id).held = true;
  return [...byOrg.values()];
}

/** One org, every class: its own values, floors and whether it is on hold. */
export async function readOneOrg(
  db: D1Database,
  orgId: string,
  now: number,
): Promise<{
  raw: Map<RetentionClass, Raw>;
  floors: Map<RetentionClass, ActiveFloor>;
  held: boolean;
}> {
  const classKeys = new Map(RETENTION_CLASSES.map((c) => [DATA_CLASSES[c].key as string, c]));
  const [own, floors, hold] = await Promise.all([
    all<{ key: string; value: string }>(
      db,
      `SELECT key, value FROM settings WHERE scope = ? AND key IN (${marks(RETENTION_CLASSES.length)})`,
      [`org:${orgId}`, ...RETENTION_CLASSES.map((c) => DATA_CLASSES[c].key)],
    ),
    all<{ class: RetentionClass; days: number; until: number }>(
      db,
      'SELECT class, days, until FROM retention_floors WHERE org_id = ? AND until > ?',
      [orgId, now],
    ),
    all<{ id: string }>(
      db,
      'SELECT id FROM retention_holds WHERE org_id = ? AND pass_id IS NULL AND released_at IS NULL LIMIT 1',
      [orgId],
    ),
  ]);
  const raw = new Map<RetentionClass, Raw>();
  for (const r of own) {
    const cls = classKeys.get(r.key);
    if (cls) raw.set(cls, parseStored(r.value));
  }
  return {
    raw,
    floors: new Map(floors.map((f) => [f.class, { days: f.days, until: f.until }])),
    held: hold.length > 0,
  };
}

/** Ids of live orgs, for a platform setting change that moves every org that follows the default. */
export async function readActiveOrgIds(db: D1Database, limit: number): Promise<string[]> {
  const rows = await all<{ id: string }>(
    db,
    "SELECT id FROM orgs WHERE status != 'deleted' ORDER BY id LIMIT ?",
    [limit],
  );
  return rows.map((r) => r.id);
}

/** Primary emails of the org's admins (role `org_admin`, which carries `org:manage`). */
export async function readOrgAdminEmails(db: D1Database, orgId: string): Promise<string[]> {
  const rows = await all<{ email: string | null }>(
    db,
    `SELECT DISTINCT ${knownEmailSql('u.primary_email')} AS email FROM org_memberships m
     JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.org_id = ? AND m.revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM json_each(m.roles) r WHERE r.value = 'org_admin')
       AND u.primary_email NOT LIKE '%.invalid'`,
    [orgId],
  );
  return rows.flatMap((r) => (r.email ? [r.email] : []));
}

/** The revision of the platform retention settings, to fence a save planned from them. */
export async function readPlatformRev(db: D1Database): Promise<number> {
  const r = await first<{ rev: number }>(db, 'SELECT rev FROM retention_platform_rev WHERE id = 1');
  return r?.rev ?? 0;
}
