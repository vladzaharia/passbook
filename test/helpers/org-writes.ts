// Raw writes to authority rows for tests that need a state change no grant would make (no session, no CAS).
import { createSessionStore } from '../../src/worker/modules/auth/sessions.ts';
import type { OrgWriteAuthority } from '../../src/worker/modules/orgs/repo-org-writes.ts';
import { tenantAuthorityOf } from '../../src/worker/modules/passes/http.ts';
import { clearSettingsCache } from '../../src/worker/modules/settings/service.ts';
import { batch, run, stmt } from '../../src/worker/platform/db.ts';
import type { ServiceContext } from '../../src/worker/platform/service-context.ts';
import { type Fixtures, makeSession, makeUser } from './factories.ts';

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

/** A fresh org admin with a live session: the `org:manage` authority an org edit commits under. */
export async function orgManager(
  f: Fixtures,
  ctx: ServiceContext,
  orgId: string,
): Promise<OrgWriteAuthority> {
  const user = await makeUser(f);
  const now = ctx.clock.now();
  const invitationId = f.ids.id();
  await run(
    f.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      invitationId,
      orgId,
      user.primaryEmail,
      '["org_admin"]',
      f.ids.token(),
      now,
      now + 3600_000,
      now,
    ],
  );
  await run(
    f.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, '["org_admin"]', ?)`,
    [f.ids.id(), orgId, user.id, invitationId, now],
  );
  const fixture = await makeSession(f, { userId: user.id });
  const session = await createSessionStore(f.env, ctx.clock).resolve(fixture.cookieValue);
  if (!session) throw new Error('The persisted session did not resolve');
  const authority = await tenantAuthorityOf(ctx, session, orgId, 'org:manage');
  if (authority.kind !== 'session') throw new Error('Expected a session authority');
  return authority;
}
