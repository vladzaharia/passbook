import { grant } from '../../platform/authority.ts';
import { epochIs } from '../../platform/authority-checks.ts';
import { all, batch, first, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { capabilityChecks, tenantPrincipal } from '../passes/repo-authority.ts';
import { orgIdOfScope } from './registry.ts';

export type SettingsAuthority = Extract<TenantPassWrite, { kind: 'session' }>;

export interface SettingRow {
  key: string;
  value: string;
  updated_by: string | null;
  updated_at: number;
}

/** Prepared separately so callers can read the platform snapshot in an authority batch. */
export function platformSettingsStmt(db: D1Database): D1PreparedStatement {
  return stmt(db, 'SELECT key, value FROM settings WHERE scope = ?', ['platform']);
}

export function readScopeRows(db: D1Database, scope: string): Promise<SettingRow[]> {
  return all<SettingRow>(
    db,
    'SELECT key, value, updated_by, updated_at FROM settings WHERE scope = ?',
    [scope],
  );
}

/** The org's `config_revision`: the CAS for a settings save. Null when the org is gone. */
export async function readOrgConfigRevision(db: D1Database, orgId: string): Promise<number | null> {
  const row = await first<{ config_revision: number }>(
    db,
    "SELECT config_revision FROM orgs WHERE id = ? AND status != 'deleted'",
    [orgId],
  );
  return row?.config_revision ?? null;
}

/** A platform admin's live session: the principal of a platform-scope settings save. */
export interface SettingsAdmin {
  userId: string;
  sessionId: string;
}

const COLUMNS = ['key', 'value', 'updated_by', 'updated_at'];
const UPDATE = ['value', 'updated_by', 'updated_at'];

/**
 * Writes one settings scope in one batch. An org scope commits only while the actor holds `org:manage`
 * with a live session and the org's `config_revision` is the one the caller read: a stale save is a
 * 409 `SETTINGS_CHANGED`, a revoked actor or suspended org a 403 (grant `org.settings.update`). A save
 * does not move `access_revision` or `updated_at`, so it never fails a pass create, bulk action or import. Without an
 * `authority` (trusted service callers and fixtures) an org write applies to any existing org with no CAS.
 * The platform scope always needs the admin's session (`platform.settings.update`).
 */
export async function writeScope(
  ctx: ServiceContext,
  scope: string,
  upserts: Record<string, unknown>,
  deletes: string[],
  by: string | null,
  revision: number | null,
  authority?: SettingsAuthority,
  admin?: SettingsAdmin,
): Promise<boolean> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const orgId = orgIdOfScope(scope);
  if (
    authority &&
    (authority.kind !== 'session' ||
      authority.orgId !== orgId ||
      authority.capability !== 'org:manage' ||
      authority.userId !== by)
  )
    return false;
  const entries = Object.entries(upserts).map(([key, value]) => [key, JSON.stringify(value)]);

  if (orgId === null) {
    // Platform settings need a live admin session at commit; there is no ungated platform write.
    if (!admin) return false;
    const g = grant(ctx, {
      purpose: 'platform.settings.update',
      principal: { kind: 'platform', userId: admin.userId, sessionIdHash: admin.sessionId },
      target: scope,
    });
    for (const [key, value] of entries)
      g.upsert('settings', ['scope', ...COLUMNS], [scope, key, value, by, now], {
        update: UPDATE,
      });
    for (const key of deletes) g.delete('settings', { where: { scope, key } });
    await g.commit();
    return true;
  }

  if (authority) {
    if (revision === null) return false;
    const g = grant(ctx, {
      purpose: 'org.settings.update',
      principal: tenantPrincipal(authority),
      target: scope,
      checks: [...capabilityChecks(authority), epochIs('orgs', orgId, 'config_revision', revision)],
      codes: { config: 'SETTINGS_CHANGED' },
    });
    for (const [key, value] of entries)
      g.upsert('settings', COLUMNS, [key, value, by, now], { update: UPDATE });
    for (const key of deletes) g.delete('settings', { where: { key } });
    // Even an empty save verifies its authority in the grant.
    await g.commit();
    return true;
  }

  const live = `EXISTS (SELECT 1 FROM orgs o WHERE o.id = ? AND o.status != 'deleted')`;
  await batch(db, [
    ...entries.map(([key, value]) =>
      stmt(
        db,
        `INSERT INTO settings (scope, key, value, updated_by, updated_at)
         SELECT ?, ?, ?, ?, ? WHERE ${live}
         ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [scope, key, value, by, now, orgId],
      ),
    ),
    ...deletes.map((key) =>
      stmt(db, `DELETE FROM settings WHERE scope = ? AND key = ? AND ${live}`, [scope, key, orgId]),
    ),
  ]);
  return true;
}

/** Internal state (cron runs, identity checks). Not exposed through the settings API. */
export async function readSystemValue(db: D1Database, key: string): Promise<unknown | null> {
  const row = await first<{ value: string }>(
    db,
    "SELECT value FROM settings WHERE scope = 'system' AND key = ?",
    [key],
  );
  return row ? JSON.parse(row.value) : null;
}

export function writeSystemValueStmt(
  db: D1Database,
  key: string,
  value: unknown,
  now: number,
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO settings (scope, key, value, updated_at) VALUES ('system', ?, ?, ?)
     ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), now],
  );
}

export async function writeSystemValue(
  db: D1Database,
  key: string,
  value: unknown,
  now: number,
): Promise<void> {
  await writeSystemValueStmt(db, key, value, now).run();
}

/**
 * Active users with no OIDC identity, so email (magic link) is their only way in. Addresses on the
 * reserved .invalid TLD (the break-glass account) receive no mail and are left out.
 */
export async function countEmailOnlyUsers(db: D1Database): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM users u
     WHERE u.status = 'active' AND u.primary_email NOT LIKE '%.invalid'
       AND NOT EXISTS (SELECT 1 FROM auth_identities a WHERE a.user_id = u.id)`,
  );
  return row?.n ?? 0;
}
