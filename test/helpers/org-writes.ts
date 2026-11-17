// Raw writes to authority rows for tests that need a state change no grant would make (no session, no CAS).
import { clearSettingsCache } from '../../src/worker/modules/settings/service.ts';
import { batch, run, stmt } from '../../src/worker/platform/db.ts';

const isAdmin = (alias: string) =>
  `EXISTS (SELECT 1 FROM json_each(${alias}.roles) ar WHERE ar.value = 'org_admin')`;

/** Revokes a membership. The last org admin stays: add another first. */
export function revokeMembership(db: D1Database, orgId: string, id: string, now: number) {
  return stmt(
    db,
    `UPDATE org_memberships SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL
     AND (NOT ${isAdmin('org_memberships')} OR EXISTS (SELECT 1 FROM org_memberships o2
       JOIN users u2 ON u2.id = o2.user_id
       WHERE o2.org_id = ? AND o2.id != ? AND o2.revoked_at IS NULL AND u2.status = 'active'
         AND ${isAdmin('o2')}))`,
    [now, id, orgId, orgId, id],
  );
}

export async function setOrgBranding(db: D1Database, id: string, branding: string, now: number) {
  await run(
    db,
    `UPDATE orgs SET branding = ?, updated_at = MAX(updated_at + 1, ?)
     WHERE id = ? AND status != 'deleted'`,
    [branding, now, id],
  );
}

/** Suspends or reactivates an org; the `orgs_inactive_cancels_broadcasts` trigger runs as in production. */
export async function setOrgStatus(
  db: D1Database,
  id: string,
  status: 'active' | 'suspended',
  now: number,
) {
  await run(
    db,
    `UPDATE orgs SET status = ?, updated_at = MAX(updated_at + 1, ?)
     WHERE id = ? AND status != 'deleted'`,
    [status, now, id],
  );
}

/** Disables or enables a user; a disable revokes the user's sessions in the same batch. */
export async function setUserStatus(
  db: D1Database,
  userId: string,
  status: 'active' | 'disabled',
  now: number,
) {
  await batch(db, [
    stmt(db, 'UPDATE users SET status = ? WHERE id = ? AND status != ?', [status, userId, status]),
    ...(status === 'disabled'
      ? [
          stmt(
            db,
            `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'disabled')`,
            [now, userId, userId],
          ),
        ]
      : []),
  ]);
}

/** Saves org settings with no actor session and no revision check. A null value deletes the key. */
export async function saveOrgSettings(
  db: D1Database,
  orgId: string,
  values: Record<string, unknown>,
  now: number,
) {
  const scope = `org:${orgId}`;
  await batch(
    db,
    Object.entries(values).map(([key, value]) =>
      value === null
        ? stmt(db, 'DELETE FROM settings WHERE scope = ? AND key = ?', [scope, key])
        : stmt(
            db,
            `INSERT INTO settings (scope, key, value, updated_by, updated_at) VALUES (?, ?, ?, NULL, ?)
             ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            [scope, key, JSON.stringify(value), now],
          ),
    ),
  );
  clearSettingsCache(db);
}
