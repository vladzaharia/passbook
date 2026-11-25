import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import type { Person } from './access-test-fixtures.ts';
import { SCIM_BREAKER_LIMIT } from './scim-effects.ts';
import { type ScimApp, scim, scimRig } from './scim-test-fixtures.ts';
import { dirtyRow, liveSessions, quietPerson, session } from './sync-test-fixtures.ts';

afterEach(() => vi.restoreAllMocks());

/** Everything the request path writes to the console, as lines. */
function captureConsole(): string[] {
  const lines: string[] = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation((...args) => void lines.push(args.join(' ')));
  return lines;
}

/** A linked person with an email-link session and two Polaris ID sessions, pushed by SCIM as active. */
async function pushed(s: ScimApp) {
  const p = await quietPerson(s.r);
  const live = [
    await session(s.r, p.id, ['user', 'console']),
    await session(s.r, p.id, ['user', 'developer']),
  ];
  const link = await session(s.r, p.id, ['user'], 'magic_link');
  const made = await scim(s, 'POST', '/Users', { externalId: p.subject, active: true });
  return { p, live, link, scimId: made.body.id as string };
}

describe('SCIM effects: sessions', () => {
  it('ends the Polaris ID sessions when a user goes inactive, keeps the email link, and does it once', async () => {
    const s = await scimRig();
    const { p, link, scimId } = await pushed(s);
    expect(
      (await scim(s, 'PUT', `/Users/${scimId}`, { externalId: p.subject, active: false })).status,
    ).toBe(200);
    expect(await liveSessions(p.id)).toEqual([link]);
    // Signed in again by some other path, then the hourly push repeats the same state: nothing more ends.
    const later = await session(s.r, p.id, ['user']);
    await scim(s, 'PUT', `/Users/${scimId}`, { externalId: p.subject, active: false });
    expect(await liveSessions(p.id)).toContain(later);
  });

  it('ends them on DELETE, and on a first sight of an inactive user', async () => {
    const s = await scimRig();
    const a = await pushed(s);
    expect((await scim(s, 'DELETE', `/Users/${a.scimId}`)).status).toBe(204);
    expect(await liveSessions(a.p.id)).toEqual([a.link]);
    const b = await quietPerson(s.r);
    await session(s.r, b.id, ['user']);
    await scim(s, 'POST', '/Users', { externalId: b.subject, active: false });
    expect(await liveSessions(b.id)).toEqual([]);
  });

  it('does nothing for a subject no PassBook user is linked to', async () => {
    const s = await scimRig();
    const audits = () =>
      all(env.DB, "SELECT id FROM audit_log WHERE action = 'idp.sessions_revoked'");
    const before = await audits();
    await scim(s, 'POST', '/Users', { externalId: 'nobody', active: false });
    expect(await audits()).toEqual(before);
  });

  it('honours dry run and a frozen binding: the mirror updates and no session ends', async () => {
    for (const mode of ['dry', 'frozen'] as const) {
      const s = await scimRig({ mode: mode === 'dry' ? 'dry_run' : 'live' });
      s.r.fake.frozen = mode === 'frozen';
      const { p, live, link, scimId } = await pushed(s);
      await scim(s, 'PUT', `/Users/${scimId}`, { externalId: p.subject, active: false });
      await scim(s, 'DELETE', `/Users/${scimId}`);
      expect(await liveSessions(p.id), mode).toEqual([...live, link].sort());
      expect(s.r.fake.writes).toBe(0);
      expect(
        await first(env.DB, 'SELECT deleted_at FROM idp_directory_users WHERE scim_id = ?', [
          scimId,
        ]),
      ).not.toBeNull();
    }
  });

  it('stops ending sessions after twenty in ten minutes, reports once, and starts again in the next window', async () => {
    const s = await scimRig();
    const logged = captureConsole();
    const people: Person[] = [];
    for (let i = 0; i < SCIM_BREAKER_LIMIT + 3; i++) {
      const p = await quietPerson(s.r);
      await session(s.r, p.id, ['user']);
      people.push(p);
      await scim(s, 'POST', '/Users', { externalId: p.subject, active: false });
    }
    const live = async () =>
      (await Promise.all(people.map((p) => liveSessions(p.id)))).filter((l) => l.length > 0);
    expect(await live()).toHaveLength(3);
    expect(logged.filter((l) => l.includes('IDP_SCIM_BREAKER'))).toHaveLength(1);
    // The owner's disables are still in the mirror; a push of a new deactivation in a later window acts again.
    s.r.f.clock.advance(11 * 60_000);
    const late = await quietPerson(s.r);
    await session(s.r, late.id, ['user']);
    await scim(s, 'POST', '/Users', { externalId: late.subject, active: false });
    expect(await liveSessions(late.id)).toEqual([]);
  });
});

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
      'scim_id',
      'subject',
    ]);
    await run(env.DB, 'DELETE FROM idp_directory_users');
  });
});
