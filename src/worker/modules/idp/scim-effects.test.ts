import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import type { Person } from './access-test-fixtures.ts';
import { drainIdp } from './jobs.ts';
import { SCIM_BREAKER_LIMIT } from './scim-effects.ts';
import { captureConsole, type ScimApp, scim, scimRig } from './scim-test-fixtures.ts';
import { calls, liveSessions, quietPerson, session } from './sync-test-fixtures.ts';

afterEach(() => vi.restoreAllMocks());

/** A linked person with two Polaris ID sessions and an email-link one, whose account is in Polaris ID with a role. */
async function pushed(s: ScimApp, active = true) {
  const p = await quietPerson(s.r);
  s.r.fake.addAccount(p.subject, { roles: ['console'] });
  const live = [
    await session(s.r, p.id, ['user', 'console']),
    await session(s.r, p.id, ['user', 'developer']),
  ];
  const link = await session(s.r, p.id, ['user'], 'magic_link');
  const made = await scim(s, 'POST', '/Users', { externalId: p.subject, active });
  return { p, live, link, scimId: made.body.id as string };
}

/** The owner switches the account off in Polaris ID, then Polaris ID pushes it. */
const ownerOff = (s: ScimApp, p: Person) => {
  const a = s.r.fake.accounts.get(p.subject);
  if (a) a.disabled = true;
};
const off = (s: ScimApp, scimId: string, p: Person) =>
  scim(s, 'PUT', `/Users/${scimId}`, { externalId: p.subject, active: false });
const mirror = (scimId: string) =>
  first<{ revoke_pending: number; revoked_at: number | null }>(
    env.DB,
    'SELECT revoke_pending, revoked_at FROM idp_directory_users WHERE scim_id = ?',
    [scimId],
  );

describe('SCIM effects: sessions', () => {
  it('ends the Polaris ID sessions once Polaris ID confirms the account is off, keeps the email link, and does it once', async () => {
    const s = await scimRig();
    const { p, link, scimId } = await pushed(s);
    ownerOff(s, p);
    expect((await off(s, scimId, p)).status).toBe(200);
    expect(await liveSessions(p.id)).toEqual([link]);
    expect(await mirror(scimId)).toMatchObject({ revoke_pending: 0 });
    // The hourly push repeats the same state: nothing more is looked up or ended.
    const later = await session(s.r, p.id, ['user']);
    const looked = calls(s.r.fake, 'lookup');
    await off(s, scimId, p);
    expect(await liveSessions(p.id)).toContain(later);
    expect(calls(s.r.fake, 'lookup')).toBe(looked);
  });

  it('ends them on DELETE of an account that left the groups, and on first sight of an off one', async () => {
    const s = await scimRig();
    const a = await pushed(s);
    s.r.fake.accounts.delete(a.p.subject);
    expect((await scim(s, 'DELETE', `/Users/${a.scimId}`)).status).toBe(204);
    expect(await liveSessions(a.p.id)).toEqual([a.link]);
    const b = await quietPerson(s.r);
    s.r.fake.addAccount(b.subject, { disabled: true });
    await session(s.r, b.id, ['user']);
    await scim(s, 'POST', '/Users', { externalId: b.subject, active: false });
    expect(await liveSessions(b.id)).toEqual([]);
  });

  it('ends nothing when Polaris ID shows the account still enabled and in a group', async () => {
    const s = await scimRig();
    const { p, live, link, scimId } = await pushed(s);
    await off(s, scimId, p);
    expect(await liveSessions(p.id)).toEqual([...live, link].sort());
    expect(await mirror(scimId)).toMatchObject({ revoke_pending: 0 });
  });

  it('does not fire again for a DELETE of an account that is already off', async () => {
    const s = await scimRig();
    const { p, scimId } = await pushed(s);
    ownerOff(s, p);
    await off(s, scimId, p);
    const looked = calls(s.r.fake, 'lookup');
    await scim(s, 'DELETE', `/Users/${scimId}`);
    expect(calls(s.r.fake, 'lookup')).toBe(looked);
  });

  it('does nothing for a subject no PassBook user is linked to', async () => {
    const s = await scimRig();
    const audits = () =>
      all(env.DB, "SELECT id FROM audit_log WHERE action = 'idp.sessions_revoked'");
    const before = await audits();
    await scim(s, 'POST', '/Users', { externalId: 'nobody', active: false });
    expect(await audits()).toEqual(before);
  });
});

describe('SCIM effects: a revocation owed is not lost', () => {
  for (const gate of ['dry', 'frozen'] as const) {
    it(`is recorded while ${gate}, and the sweep ends the sessions once the gate is live`, async () => {
      const s = await scimRig({ mode: gate === 'dry' ? 'dry_run' : 'live' });
      s.r.fake.frozen = gate === 'frozen';
      const { p, live, link, scimId } = await pushed(s);
      ownerOff(s, p);
      await off(s, scimId, p);
      expect(await liveSessions(p.id)).toEqual([...live, link].sort());
      expect(s.r.fake.writes).toBe(0);
      expect(await mirror(scimId)).toMatchObject({ revoke_pending: 1 });
      await drainIdp(s.r.ctx);
      expect(await liveSessions(p.id), 'still gated').toHaveLength(3);
      s.r.fake.frozen = false;
      s.r.fake.mode = 'live';
      await drainIdp(s.r.ctx);
      expect(await liveSessions(p.id)).toEqual([link]);
      expect(await mirror(scimId)).toMatchObject({ revoke_pending: 0 });
    });
  }

  it('records a DELETE the same way, and a switch back on clears it', async () => {
    const s = await scimRig({ mode: 'dry_run' });
    const a = await pushed(s);
    s.r.fake.accounts.delete(a.p.subject);
    await scim(s, 'DELETE', `/Users/${a.scimId}`);
    expect(await mirror(a.scimId)).toMatchObject({ revoke_pending: 1 });
    const b = await pushed(s);
    ownerOff(s, b.p);
    await off(s, b.scimId, b.p);
    await scim(s, 'PUT', `/Users/${b.scimId}`, { externalId: b.p.subject, active: true });
    expect(await mirror(b.scimId)).toMatchObject({ revoke_pending: 0 });
  });

  it('keeps it pending when Polaris ID cannot answer the confirming lookup', async () => {
    const s = await scimRig();
    const { p, scimId } = await pushed(s);
    ownerOff(s, p);
    s.r.fake.lookup = async () => {
      throw new Error('IDP_UPSTREAM: down');
    };
    await off(s, scimId, p);
    expect(await mirror(scimId)).toMatchObject({ revoke_pending: 1 });
  });

  it('ends only sessions started before the change, and limits a subject to one revocation an hour', async () => {
    const s = await scimRig();
    const { p, scimId } = await pushed(s);
    ownerOff(s, p);
    await off(s, scimId, p);
    const again = async () => {
      await scim(s, 'PUT', `/Users/${scimId}`, { externalId: p.subject, active: true });
      const now = s.r.f.clock.now();
      // Long-lived, so it is still live when the hour is up.
      await run(
        env.DB,
        `INSERT INTO sessions (id_hash, user_id, amr, roles, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at)
         VALUES (?, ?, 'oidc', '["user"]', 'csrf', ?, ?, ?, ?)`,
        [s.r.f.ids.id(), p.id, now, now, now + 10 * 3_600_000, now + 10 * 3_600_000],
      );
      await off(s, scimId, p);
    };
    await again();
    expect(await mirror(scimId)).toMatchObject({ revoke_pending: 1 });
    expect(await liveSessions(p.id)).toHaveLength(2);
    s.r.f.clock.advance(61 * 60_000);
    await drainIdp(s.r.ctx);
    expect(await liveSessions(p.id)).toHaveLength(1);
    expect(await mirror(scimId)).toMatchObject({ revoke_pending: 0 });
  });
});

describe('SCIM effects: the sweep does not stall on a row it cannot settle', () => {
  it('backs a failing row off, so newer rows are settled, and tries it again later', async () => {
    const s = await scimRig({ mode: 'dry_run' });
    const stuck: Person[] = [];
    for (let i = 0; i < 20; i++) {
      const a = await pushed(s);
      ownerOff(s, a.p);
      await off(s, a.scimId, a.p);
      stuck.push(a.p);
    }
    s.r.f.clock.advance(1_000);
    const newer = await pushed(s);
    ownerOff(s, newer.p);
    await off(s, newer.scimId, newer.p);
    const failing = new Set(stuck.map((p) => p.subject));
    const lookup = s.r.fake.lookup.bind(s.r.fake);
    s.r.fake.lookup = async (subject) => {
      if (failing.has(subject)) throw new Error('IDP_UPSTREAM: down');
      return lookup(subject);
    };
    s.r.fake.mode = 'live';
    await drainIdp(s.r.ctx);
    expect(await mirror(newer.scimId), 'first batch is the 20 older rows').toMatchObject({
      revoke_pending: 1,
    });
    const row = await first<{ revoke_tries: number; revoke_next_at: number }>(
      env.DB,
      'SELECT revoke_tries, revoke_next_at FROM idp_directory_users WHERE subject = ?',
      [stuck[0]?.subject ?? ''],
    );
    expect(row?.revoke_tries).toBe(1);
    expect(row?.revoke_next_at).toBeGreaterThan(s.r.f.clock.now());
    await drainIdp(s.r.ctx);
    expect(await mirror(newer.scimId)).toMatchObject({ revoke_pending: 0 });
    expect(await liveSessions(newer.p.id)).toEqual([newer.link]);
    // Past the backoff the failing rows are tried again, and settle once Polaris ID answers.
    failing.clear();
    s.r.f.clock.advance(11 * 60_000);
    await drainIdp(s.r.ctx);
    expect(await liveSessions(stuck[0]?.id ?? '')).toHaveLength(1);
  });
});

describe('SCIM effects: the breaker latches', () => {
  it('stops after twenty in ten minutes, reports once, stays open past the window, and a sweep finishes once it closes', async () => {
    const s = await scimRig();
    const logged = captureConsole();
    const people: Person[] = [];
    const ids: string[] = [];
    for (let i = 0; i < SCIM_BREAKER_LIMIT + 3; i++) {
      const p = await quietPerson(s.r);
      s.r.fake.addAccount(p.subject, { disabled: true });
      await session(s.r, p.id, ['user']);
      people.push(p);
      ids.push((await scim(s, 'POST', '/Users', { externalId: p.subject, active: false })).body.id);
    }
    const live = async () =>
      (await Promise.all(people.map((p) => liveSessions(p.id)))).filter((l) => l.length > 0);
    expect(await live()).toHaveLength(3);
    expect(logged.filter((l) => l.includes('IDP_SCIM_BREAKER'))).toHaveLength(1);
    expect(await mirror(ids[22] ?? '')).toMatchObject({ revoke_pending: 1 });
    // A later window, still inside the day: new switch-offs are recorded, not acted on, and the sweep waits.
    s.r.f.clock.advance(11 * 60_000);
    const late = await quietPerson(s.r);
    s.r.fake.addAccount(late.subject, { disabled: true });
    await session(s.r, late.id, ['user']);
    await scim(s, 'POST', '/Users', { externalId: late.subject, active: false });
    await drainIdp(s.r.ctx);
    expect(await liveSessions(late.id)).toHaveLength(1);
    expect(await live()).toHaveLength(3);
    // The owner clears it (docs/operations.md): the sweep ends what is owed.
    await run(env.DB, "DELETE FROM counters WHERE key = 'idp:scim:breaker'");
    await drainIdp(s.r.ctx);
    expect(await liveSessions(late.id)).toEqual([]);
    expect(await live()).toHaveLength(0);
  });

  it('clearing the latch inside the same window ends what is owed and does not latch again', async () => {
    const s = await scimRig();
    const logged = captureConsole();
    const people: Person[] = [];
    for (let i = 0; i < SCIM_BREAKER_LIMIT + 2; i++) {
      const p = await quietPerson(s.r);
      s.r.fake.addAccount(p.subject, { disabled: true });
      await session(s.r, p.id, ['user']);
      people.push(p);
      await scim(s, 'POST', '/Users', { externalId: p.subject, active: false });
    }
    await run(env.DB, "DELETE FROM counters WHERE key = 'idp:scim:breaker'");
    await drainIdp(s.r.ctx);
    for (const p of people) expect(await liveSessions(p.id)).toEqual([]);
    expect(logged.filter((l) => l.includes('IDP_SCIM_BREAKER'))).toHaveLength(1);
  });

  it('closes by itself after a day', async () => {
    const s = await scimRig();
    await run(env.DB, 'INSERT INTO counters (key, window_start, count) VALUES (?, ?, 1)', [
      'idp:scim:breaker',
      s.r.f.clock.now(),
    ]);
    const { p, scimId } = await pushed(s);
    ownerOff(s, p);
    await off(s, scimId, p);
    expect(await mirror(scimId)).toMatchObject({ revoke_pending: 1 });
    s.r.f.clock.advance(25 * 3_600_000);
    await drainIdp(s.r.ctx);
    expect(await mirror(scimId)).toMatchObject({ revoke_pending: 0 });
  });
});
