import { callerPrincipal, type PlatformCaller } from '../../platform/actor.ts';
import { grant } from '../../platform/authority.ts';
import { all, chunk, first, placeholders, prefixMatch, run } from '../../platform/db.ts';
import { knownEmailSql } from '../../platform/known-email-sql.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { UserRow } from '../auth/repo.ts';

export { getUser, type UserRow } from '../auth/repo.ts';
export { getSession, listRecentSessions } from '../auth/repo-sessions.ts';

type Db = D1Database;

export interface UserFacts {
  pass_count: number;
  has_email: number;
  /** Identity providers linked to the user, comma separated. */
  providers: string | null;
}

/** Pass count, whether a verified email exists and the linked identity providers, per user. */
export async function factsFor(
  db: Db,
  userIds: readonly string[],
  viewerId = '',
): Promise<Map<string, UserFacts>> {
  const out = new Map<string, UserFacts>();
  for (const ids of chunk(userIds)) {
    const rows = await all<UserFacts & { id: string }>(
      db,
      `SELECT u.id AS id,
         (SELECT count(*) FROM passes p JOIN orgs o ON o.id = p.org_id
          WHERE p.owner_user_id = u.id AND p.deleted_at IS NULL AND p.mode = 'live'
            AND o.status IN ('active', 'suspended')
            AND (o.personal_user_id IS NULL OR o.personal_user_id = ?)) AS pass_count,
         EXISTS (SELECT 1 FROM user_emails e WHERE e.user_id = u.id) AS has_email,
         (SELECT group_concat(DISTINCT a.provider) FROM auth_identities a WHERE a.user_id = u.id) AS providers
       FROM users u WHERE u.id IN (${placeholders(ids.length)})`,
      [viewerId, ...ids],
    );
    for (const { id, ...facts } of rows) out.set(id, facts);
  }
  return out;
}

/** Only a verified address of the same user can become primary. */
export async function setPrimaryEmail(db: Db, userId: string, email: string): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE users SET primary_email = ?, primary_set_amr = 'oidc'
     WHERE id = ? AND EXISTS (SELECT 1 FROM user_emails WHERE email = ? AND user_id = ?)`,
    [email, userId, email, userId],
  );
  return changes > 0;
}

export interface ListFilter {
  q?: string;
  status?: 'active' | 'disabled';
  cursor?: string;
  limit: number;
}

/** Newest first. The cursor is the last id (UUIDv7, so id order is creation order). */
export async function listUsers(db: Db, f: ListFilter): Promise<UserRow[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.status) {
    where.push('status = ?');
    params.push(f.status);
  }
  if (f.cursor) {
    where.push('id < ?');
    params.push(f.cursor);
  }
  const q = f.q?.trim();
  if (q) {
    // Prefix match on NOCASE-indexed columns; the contains search it replaces could only scan.
    const email = prefixMatch('primary_email', q);
    const name = prefixMatch('name', q);
    const alias = prefixMatch('email', q);
    where.push(
      `id IN (SELECT id FROM users WHERE id = ?
        UNION SELECT id FROM users WHERE ${email.sql} AND ${knownEmailSql('primary_email')} IS NOT NULL
        UNION SELECT id FROM users WHERE ${name.sql}
        UNION SELECT user_id FROM user_emails WHERE ${alias.sql})`,
    );
    params.push(q, ...email.params, ...name.params, ...alias.params);
  }
  params.push(f.limit + 1);
  return all<UserRow>(
    db,
    `SELECT * FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
    params,
  );
}

export const identitiesOf = (db: Db, userId: string) =>
  all<{
    provider: string;
    subject: string;
    email_claim: string | null;
    email_verified: number;
    groups: string;
    last_used_at: number | null;
  }>(
    db,
    `SELECT provider, subject, email_claim, email_verified, groups, last_used_at
     FROM auth_identities WHERE user_id = ? ORDER BY created_at`,
    [userId],
  );

export interface OwnedPassRow {
  id: string;
  template_name: string;
  name: string;
  personal_user_id: string | null;
  status: 'active' | 'voided';
}

/** Another person's personal organization is not listed to a platform admin; the viewer's own is. */
export const ownedPasses = (db: Db, userId: string, viewerId: string) =>
  all<OwnedPassRow>(
    db,
    `SELECT p.id, COALESCE(t.name, p.template_id) AS template_name, o.name, o.personal_user_id, p.status
     FROM passes p
     JOIN orgs o ON o.id = p.org_id
     LEFT JOIN templates t ON t.id = p.template_id
     WHERE p.owner_user_id = ? AND p.deleted_at IS NULL AND p.mode = 'live'
       AND o.status IN ('active', 'suspended')
       AND (o.personal_user_id IS NULL OR o.personal_user_id = ?)
     ORDER BY p.id DESC LIMIT 100`,
    [userId, viewerId],
  );

export async function ownedPassCount(db: Db, userId: string, viewerId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM passes p JOIN orgs o ON o.id = p.org_id
     WHERE p.owner_user_id = ? AND p.deleted_at IS NULL AND p.mode = 'live'
       AND o.status IN ('active', 'suspended')
       AND (o.personal_user_id IS NULL OR o.personal_user_id = ?)`,
    [userId, viewerId],
  );
  return row?.n ?? 0;
}

const PUBLIC_ORG =
  'AND (org_id IS NULL OR org_id NOT IN (SELECT id FROM orgs WHERE personal_user_id IS NOT NULL))';

/** `excludePersonal`: a Platform key never sees a personal org's rows. */
export const recentAudit = (db: Db, userId: string, excludePersonal = false) =>
  all<{ id: number; at: number; action: string; actor_type: string; actor_id: string | null }>(
    db,
    `SELECT id, at, action, actor_type, actor_id FROM audit_log
     WHERE target_type = 'user' AND target_id = ?
       ${excludePersonal ? PUBLIC_ORG : ''}
     ORDER BY at DESC, id DESC LIMIT 20`,
    [userId],
  );

/** The same change as a `platform.user.*` grant: the acting admin's session must be live at commit. */
export async function setStatusAsAdmin(
  ctx: ServiceContext,
  userId: string,
  status: 'active' | 'disabled',
  admin: PlatformCaller,
): Promise<boolean> {
  const now = ctx.clock.now();
  const g = grant(ctx, {
    purpose: status === 'disabled' ? 'platform.user.disable' : 'platform.user.enable',
    principal: callerPrincipal(admin),
    target: userId,
  });
  g.update('users', {
    set: { status },
    where: { id: userId, status: status === 'active' ? 'disabled' : 'active' },
    returning: ['id'],
  });
  if (status === 'disabled')
    g.update('sessions', {
      set: { revoked_at: now },
      where: { user_id: userId, revoked_at: null },
    });
  const [result] = await g.commit();
  return (result?.results.length ?? 0) > 0;
}

export async function removeEmail(db: Db, userId: string, email: string): Promise<boolean> {
  const { changes } = await run(db, 'DELETE FROM user_emails WHERE user_id = ? AND email = ?', [
    userId,
    email,
  ]);
  return changes > 0;
}
