import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import type { Person } from './access-test-fixtures.ts';
import { SCIM_MARKS_PER_HOUR } from './scim-effects.ts';
import { captureConsole, type ScimApp, scim, scimRig } from './scim-test-fixtures.ts';
import { dirtyRow, liveSessions, quietPerson, session } from './sync-test-fixtures.ts';

afterEach(() => vi.restoreAllMocks());

describe('SCIM effects: group members', () => {
  async function group(s: ScimApp, subjects: string[]) {
    const ids: string[] = [];
    for (const sub of subjects)
      ids.push((await scim(s, 'POST', '/Users', { externalId: sub })).body.id);
    const made = await scim(s, 'POST', '/Groups', {
      externalId: 'grp-1',
      members: ids.map((value) => ({ value })),
    });
    return { ids, groupId: made.body.id as string };
  }

  it('queues a removed linked member for the drain, and nobody else', async () => {
    const s = await scimRig();
    const a = await quietPerson(s.r);
    const b = await quietPerson(s.r);
    const { ids, groupId } = await group(s, [a.subject, b.subject, 'unlinked']);
    expect(await all(env.DB, 'SELECT subject FROM idp_dirty')).toEqual([]);
    await scim(s, 'PUT', `/Groups/${groupId}`, {
      externalId: 'grp-1',
      members: [{ value: ids[1] }],
    });
    expect(await dirtyRow(a.subject)).not.toBeNull();
    expect(await dirtyRow(b.subject)).toBeNull();
    expect(await dirtyRow('unlinked')).toBeNull();
  });

  it('queues every member of a deleted group, and nobody for an added one', async () => {
    const s = await scimRig();
    const a = await quietPerson(s.r);
    const c = await quietPerson(s.r);
    const { ids, groupId } = await group(s, [a.subject]);
    const added = (await scim(s, 'POST', '/Users', { externalId: c.subject })).body.id;
    await scim(s, 'PUT', `/Groups/${groupId}`, {
      externalId: 'grp-1',
      members: [...ids, added].map((value) => ({ value })),
    });
    expect(await all(env.DB, 'SELECT subject FROM idp_dirty')).toEqual([]);
    await scim(s, 'DELETE', `/Groups/${groupId}`);
    expect(await dirtyRow(a.subject)).not.toBeNull();
    expect(await dirtyRow(c.subject)).not.toBeNull();
  });

  it('queues nobody in dry run', async () => {
    const s = await scimRig({ mode: 'dry_run' });
    const a = await quietPerson(s.r);
    const { groupId } = await group(s, [a.subject]);
    await scim(s, 'PUT', `/Groups/${groupId}`, { externalId: 'grp-1', members: [] });
    expect(await dirtyRow(a.subject)).toBeNull();
  });
});

describe("SCIM effects: marks keep within a budget and the drain's backoff", () => {
  it('queues no more than the hour allows, and keeps the backoff of a subject that is failing', async () => {
    const s = await scimRig();
    const failing = await quietPerson(s.r);
    await run(env.DB, 'INSERT INTO idp_dirty (subject, attempts, next_at) VALUES (?, 3, ?)', [
      failing.subject,
      s.r.f.clock.now() + 6 * 3_600_000,
    ]);
    const members: Person[] = [failing];
    for (let i = 0; i < 4; i++) members.push(await quietPerson(s.r));
    const ids: string[] = [];
    for (const m of members)
      ids.push((await scim(s, 'POST', '/Users', { externalId: m.subject })).body.id);
    const made = await scim(s, 'POST', '/Groups', {
      externalId: 'grp-1',
      members: ids.map((value) => ({ value })),
    });
    const hour = Math.floor(s.r.f.clock.now() / 3_600_000) * 3_600_000;
    await run(env.DB, 'INSERT INTO counters (key, window_start, count) VALUES (?, ?, ?)', [
      'idp:scim:marks',
      hour,
      SCIM_MARKS_PER_HOUR - 2,
    ]);
    await scim(s, 'PUT', `/Groups/${made.body.id}`, { externalId: 'grp-1', members: [] });
    const used = await first<{ count: number }>(
      env.DB,
      "SELECT count FROM counters WHERE key = 'idp:scim:marks' AND window_start = ?",
      [hour],
    );
    expect(used?.count).toBe(SCIM_MARKS_PER_HOUR);
    const row = await dirtyRow(failing.subject);
    expect(row).toMatchObject({ attempts: 3 });
    expect(row?.next_at).toBeGreaterThan(s.r.f.clock.now());
    expect((await all(env.DB, 'SELECT subject FROM idp_dirty')).length).toBeLessThanOrEqual(3);
  });
});

let groupSeq = 0;

describe('SCIM effects: platform admins taken out of a group', () => {
  async function admin(s: ScimApp, inAdminGroup = true) {
    const p = await quietPerson(s.r, { lastRoles: ['admin'] });
    s.r.fake.addAccount(p.subject, { roles: inAdminGroup ? ['platform_admin'] : [] });
    const sessions = [
      await session(s.r, p.id, ['user', 'admin']),
      await session(s.r, p.id, ['user', 'console']),
    ];
    const id = (await scim(s, 'POST', '/Users', { externalId: p.subject })).body.id as string;
    return { p, id, sessions };
  }
  const drop = async (s: ScimApp, ids: string[]) => {
    groupSeq += 1;
    const made = await scim(s, 'POST', '/Groups', {
      externalId: `grp-${groupSeq}`,
      members: ids.map((value) => ({ value })),
    });
    await scim(s, 'PUT', `/Groups/${made.body.id}`, { ...made.body, members: [] });
  };
  const adminSessions = async (userId: string) =>
    (
      await all<{ roles: string }>(
        env.DB,
        'SELECT roles FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
        [userId],
      )
    ).filter((r) => r.roles.includes('"admin"')).length;

  it('ends admin sessions within the push when Polaris ID shows no admin group, and files the difference', async () => {
    const s = await scimRig();
    const a = await admin(s, false);
    await drop(s, [a.id]);
    expect(await adminSessions(a.p.id)).toBe(0);
    expect(await liveSessions(a.p.id)).toHaveLength(1);
    const drift = await all(
      env.DB,
      "SELECT kind FROM idp_drift WHERE subject = ? AND kind = 'admin_changed'",
      [a.p.subject],
    );
    expect(drift).toHaveLength(1);
  });

  it('keeps them while the account is still an admin, when the lookup fails, and in dry run', async () => {
    const s = await scimRig();
    const still = await admin(s, true);
    const gone = await admin(s, false);
    s.r.fake.accounts.delete(gone.p.subject);
    await drop(s, [still.id, gone.id]);
    expect(await adminSessions(still.p.id)).toBe(1);
    expect(await adminSessions(gone.p.id)).toBe(1);
    const dry = await scimRig({ mode: 'dry_run' });
    const d = await admin(dry, false);
    await drop(dry, [d.id]);
    expect(await adminSessions(d.p.id)).toBe(1);
  });

  it('reports and revokes nothing when more than five are dropped at once', async () => {
    const s = await scimRig();
    const logged = captureConsole();
    const people = [];
    for (let i = 0; i < 6; i++) people.push(await admin(s, false));
    await drop(
      s,
      people.map((a) => a.id),
    );
    for (const a of people) expect(await adminSessions(a.p.id)).toBe(1);
    expect(logged.filter((l) => l.includes('idp.scim.admin_breaker'))).toHaveLength(1);
    expect(
      await all(
        env.DB,
        "SELECT id FROM idp_drift WHERE kind = 'admin_changed' AND subject IN (" +
          people.map(() => '?').join(',') +
          ')',
        people.map((a) => a.p.subject),
      ),
    ).toEqual([]);
  });
});

const TABLES = [
  'users',
  'auth_identities',
  'org_memberships',
  'org_invitations',
  'platform_role_grants',
  'idp_target_state',
  'idp_group_members',
  'idp_drift',
];

describe('SCIM invariants: no input grants, and nothing personal is kept', () => {
  it('leaves users, memberships, grants and sessions as they were, whatever the body claims', async () => {
    const s = await scimRig();
    const p = await quietPerson(s.r);
    const live = await session(s.r, p.id, ['user']);
    const count = async (t: string) =>
      (await first<{ n: number }>(env.DB, `SELECT count(*) AS n FROM ${t}`))?.n;
    const before = await Promise.all(TABLES.map(count));
    const sessionsBefore = await count('sessions');
    const sentinel = 'leak-check-person@example.test';
    const hostile = {
      externalId: p.subject,
      active: true,
      userName: sentinel,
      displayName: 'Leak Check Name',
      name: { givenName: 'Leak', familyName: 'Check' },
      emails: [{ value: sentinel, primary: true }],
      roles: ['admin', 'console'],
      groups: [{ value: 'wallet_admins' }],
      isAdmin: true,
      'urn:ext': { admin: true },
    };
    const logged = captureConsole();
    const made = await scim(s, 'POST', '/Users', hostile);
    await scim(s, 'PUT', `/Users/${made.body.id}`, hostile);
    const grp = await scim(s, 'POST', '/Groups', {
      externalId: 'grp-x',
      displayName: sentinel,
      members: [{ value: made.body.id }],
      admin: true,
    });
    await scim(s, 'PUT', `/Groups/${grp.body.id}`, {
      externalId: 'grp-x',
      displayName: sentinel,
      members: [],
    });
    await scim(s, 'POST', '/Users', { ...hostile, externalId: sentinel });
    await scim(s, 'GET', '/Users', undefined, { token: sentinel });

    expect(await Promise.all(TABLES.map(count))).toEqual(before);
    expect(await count('sessions')).toBe(sessionsBefore);
    expect(await liveSessions(p.id)).toContain(live);
    expect(s.r.fake.writes).toBe(0);
    const stored = JSON.stringify([
      ...(await all(env.DB, 'SELECT * FROM idp_directory_users')),
      ...(await all(env.DB, 'SELECT * FROM idp_directory_groups')),
      ...(await all(env.DB, 'SELECT * FROM idp_dirty')),
      ...(await all(env.DB, 'SELECT * FROM audit_log')),
      ...s.r.logs,
      logged,
    ]);
    for (const secret of [sentinel, 'Leak Check', 'Leak', 'wallet_admins'])
      expect(stored).not.toContain(secret);
  });

  it('keeps only ids and flags in the mirror', async () => {
    const s = await scimRig();
    await scim(s, 'POST', '/Users', { externalId: 'sub-1', emails: [{ value: 'a@example.test' }] });
    const cols = await all<{ name: string }>(
      env.DB,
      "SELECT name FROM pragma_table_info('idp_directory_users')",
    );
    expect(cols.map((c) => c.name).sort()).toEqual([
      'active',
      'deleted_at',
      'last_modified',
      'revoke_next_at',
      'revoke_pending',
      'revoke_tries',
      'revoked_at',
      'scim_id',
      'subject',
    ]);
    await run(env.DB, 'DELETE FROM idp_directory_users');
  });
});
