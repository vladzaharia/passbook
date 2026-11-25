import { env } from 'cloudflare:workers';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { all, run, type SqlValue } from '../../platform/db.ts';

/** Fresh fixtures on the test D1 (its storage lasts for the file, so every id is new). */
export async function world(): Promise<Fixtures> {
  return fixtures(await makeEnv());
}

export const db = (): D1Database => env.DB;

/** The error message a statement is refused with, or null when it ran. */
export async function refused(sql: string, params: SqlValue[] = []): Promise<string | null> {
  try {
    await run(env.DB, sql, params);
    return null;
  } catch (e) {
    return String((e as Error).cause ?? e);
  }
}

export function insert(table: string, row: Record<string, SqlValue>, verb = 'INSERT') {
  const cols = Object.keys(row);
  return refused(
    `${verb} INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    Object.values(row),
  );
}

export const update = (table: string, set: string, where: string, params: SqlValue[] = []) =>
  refused(`UPDATE ${table} SET ${set} WHERE ${where}`, params);

export interface Person {
  id: string;
  email: string;
  subject: string;
}

/** A PassBook user linked to a Polaris ID subject. */
export async function person(
  f: Fixtures,
  opts: { lastRoles?: string[]; link?: boolean } = {},
): Promise<Person> {
  const user = await makeUser(f);
  const subject = `sub-${user.id}`;
  if (opts.lastRoles)
    await run(env.DB, 'UPDATE users SET last_roles = ? WHERE id = ?', [
      JSON.stringify(opts.lastRoles),
      user.id,
    ]);
  if (opts.link !== false)
    await run(
      env.DB,
      `INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('pocketid', ?, ?, ?)`,
      [subject, user.id, f.clock.now()],
    );
  return { id: user.id, email: user.primaryEmail, subject };
}

export const standardOrg = (f: Fixtures) => makeOrg(f);
export const sandboxOrg = (f: Fixtures) => makeOrg(f, { kind: 'developer' });

/** A personal org of `userId`: its one member is its owner, through an accepted invitation. */
export async function personalOrg(f: Fixtures, p: Person): Promise<string> {
  const id = f.ids.id();
  const now = f.clock.now();
  await run(
    env.DB,
    `INSERT INTO orgs (id, slug, name, personal_user_id, created_at, updated_at) VALUES (?, ?, 'Personal', ?, ?, ?)`,
    [id, `org-${id}`, p.id, now, now],
  );
  await run(env.DB, 'INSERT INTO org_entitlements (org_id, preset, updated_at) VALUES (?, ?, ?)', [
    id,
    'legacy',
    now,
  ]);
  await membership(f, id, p, ['org_admin'], p.email);
  return id;
}

/** An accepted org invitation and the live membership it made. Returns the membership id. */
export async function membership(
  f: Fixtures,
  orgId: string,
  p: Person,
  roles: string[] = ['org_admin'],
  email = p.email,
): Promise<string> {
  const invitationId = f.ids.id();
  const id = f.ids.id();
  const now = f.clock.now();
  await run(
    env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [invitationId, orgId, email, JSON.stringify(roles), f.ids.token(), now, now + 1000, now],
  );
  await run(
    env.DB,
    'INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, orgId, p.id, invitationId, JSON.stringify(roles), now],
  );
  return id;
}

export const revokeMembership = (id: string, now: number) =>
  run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [now, id]);

/** A pending org invitation. */
export async function orgInvitation(
  f: Fixtures,
  orgId: string,
  email: string,
  roles: string[] = ['read_only'],
  lifetimeMs = 1000,
): Promise<string> {
  const id = f.ids.id();
  const now = f.clock.now();
  await run(
    env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, orgId, email, JSON.stringify(roles), f.ids.token(), now, now + lifetimeMs],
  );
  return id;
}

/** A pending developer invitation by a user of the org, optionally paired with an org invitation. */
export async function developerInvitation(
  f: Fixtures,
  orgId: string,
  createdBy: string,
  opts: { email?: string; paired?: string | null; claimUntil?: number } = {},
): Promise<string> {
  const id = f.ids.id();
  const now = f.clock.now();
  await run(
    env.DB,
    `INSERT INTO developer_invitations (id, org_id, email, token_hash, org_invitation_id, created_by_user, created_at, expires_at, claim_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      orgId,
      opts.email ?? 'dev@example.test',
      f.ids.token(),
      opts.paired ?? null,
      createdBy,
      now,
      now + 1000,
      opts.claimUntil ?? now + 5000,
    ],
  );
  return id;
}

/** A live sponsorship, through an accepted developer invitation. Returns the sponsor id. */
export async function sponsor(f: Fixtures, orgId: string, p: Person): Promise<string> {
  const invitation = await developerInvitation(f, orgId, p.id);
  const now = f.clock.now();
  await run(
    env.DB,
    'UPDATE developer_invitations SET accepted_at = ?, accepted_user_id = ? WHERE id = ?',
    [now, p.id, invitation],
  );
  const id = f.ids.id();
  await run(
    env.DB,
    `INSERT INTO developer_sponsors (id, org_id, user_id, invitation_id, idp_subject, group_source, created_at)
     VALUES (?, ?, ?, ?, ?, 'signup', ?)`,
    [id, orgId, p.id, invitation, p.subject, now],
  );
  return id;
}

export async function group(f: Fixtures, key: string, createdBy: string | null = null) {
  await run(
    env.DB,
    "INSERT INTO idp_groups (key, kind, friendly_name, created_by, created_at) VALUES (?, 'custom', ?, ?, ?)",
    [key, `Group ${key}`, createdBy, f.clock.now()],
  );
}

export async function rule(
  f: Fixtures,
  groupKey: string,
  orgId: string,
  createdBy: string,
  roles: string[] | null = null,
): Promise<string> {
  const id = f.ids.id();
  await run(
    env.DB,
    'INSERT INTO idp_group_rules (id, group_key, org_id, org_roles, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, groupKey, orgId, roles ? JSON.stringify(roles) : null, createdBy, f.clock.now()],
  );
  return id;
}

/** A platform invitation by a user, with groups that must already exist. */
export async function platformInvitation(
  f: Fixtures,
  createdBy: string,
  opts: { groups?: string[]; developer?: boolean; claimUntil?: number } = {},
): Promise<string> {
  const id = f.ids.id();
  const now = f.clock.now();
  await run(
    env.DB,
    `INSERT INTO platform_invitations (id, email, token_hash, groups, developer, created_by_user, created_at, expires_at, claim_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      'guest@example.test',
      f.ids.token(),
      JSON.stringify(opts.groups ?? []),
      opts.developer ? 1 : 0,
      createdBy,
      now,
      now + 1000,
      opts.claimUntil ?? now + 5000,
    ],
  );
  return id;
}

export async function claim(
  f: Fixtures,
  parent: { org?: string; developer?: string; platform?: string },
  subject: string,
  claimUntil: number = f.clock.now() + 3000,
): Promise<string> {
  const id = f.ids.id();
  await run(
    env.DB,
    `INSERT INTO idp_invite_claims (id, org_invitation_id, developer_invitation_id, platform_invitation_id, subject, created_at, claim_until)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      parent.org ?? null,
      parent.developer ?? null,
      parent.platform ?? null,
      subject,
      f.clock.now(),
      claimUntil,
    ],
  );
  return id;
}

/** The marked subjects among `subjects`. */
export async function marked(subjects: string[]): Promise<string[]> {
  const rows = await all<{ subject: string }>(
    env.DB,
    `SELECT subject FROM idp_dirty WHERE subject IN (${subjects.map(() => '?').join(',')}) ORDER BY subject`,
    subjects,
  );
  return rows.map((r) => r.subject);
}

export const clearMarks = (subjects: string[]) =>
  run(
    env.DB,
    `DELETE FROM idp_dirty WHERE subject IN (${subjects.map(() => '?').join(',')})`,
    subjects,
  );

/** An org closed and in purge, which is the only state that lets the triggers delete its history. */
export const startPurge = (orgId: string, now: number) =>
  run(
    env.DB,
    "UPDATE orgs SET status = 'deleted', closed_at = ?, purge_after = ?, purge_started_at = ? WHERE id = ?",
    [now, now, now, orgId],
  );
