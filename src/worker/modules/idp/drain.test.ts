import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import {
  claim,
  group,
  membership,
  orgInvitation,
  person,
  revokeMembership,
  rule,
  sponsor,
  standardOrg,
} from './access-test-fixtures.ts';
import { DRY_DEFER_MS, drainIdp } from './jobs.ts';
import { markDirty } from './repo-dirty.ts';
import { clearHold } from './repo-state.ts';
import {
  auditActions,
  calls,
  dirtyRow,
  driftKinds,
  liveSessions,
  ownerRemoves,
  passbookAdded,
  quietPerson,
  type Rig,
  rig,
  session,
  stateRows,
} from './sync-test-fixtures.ts';

beforeEach(() => run(env.DB, 'DELETE FROM idp_dirty'));

const roles = (r: Rig, subject: string) => [...(r.fake.accounts.get(subject)?.roles ?? [])].sort();
const later = (r: Rig, ms: number) => r.f.clock.advance(ms);

describe('drain: add and remove', () => {
  it('adds what is wanted, records it, audits it and clears the mark', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject, { class: 'created' });
    await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    expect([...(r.fake.accounts.get(p.subject)?.grants ?? [])]).toEqual(['console']);
    expect(r.fake.writes).toBe(1);
    const [state] = await stateRows(p.subject);
    expect(state).toMatchObject({ target: 'console', observed: 1, presence: 'passbook' });
    expect(state?.applied_at).not.toBeNull();
    expect(await auditActions(p.id)).toEqual(['idp.access_added']);
    expect(await dirtyRow(p.subject)).toBeNull();
  });

  it('is idempotent: a second run with nothing new sends no write and adds no audit row', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    const before = {
      applies: calls(r.fake, 'apply'),
      audit: await auditActions(p.id),
      states: await stateRows(p.subject),
    };
    await markDirty(env.DB, p.subject);
    await drainIdp(r.ctx);
    expect(calls(r.fake, 'apply')).toBe(before.applies);
    expect(await auditActions(p.id)).toEqual(before.audit);
    expect(await stateRows(p.subject)).toEqual(before.states);
    expect(await dirtyRow(p.subject)).toBeNull();
  });

  it('removes once when the last reason ends, and not while another reason remains', async () => {
    const r = await rig();
    const a = await standardOrg(r.f);
    const b = await standardOrg(r.f);
    const p = await person(r.f);
    passbookAdded(r, p.subject, ['console']);
    const ma = await membership(r.f, a.id, p);
    const mb = await membership(r.f, b.id, p);
    await drainIdp(r.ctx);
    expect(calls(r.fake, 'apply')).toBe(0);
    await revokeMembership(ma, r.f.clock.now());
    await drainIdp(r.ctx);
    expect(calls(r.fake, 'apply')).toBe(0);
    expect(roles(r, p.subject)).toEqual(['console']);
    await revokeMembership(mb, r.f.clock.now());
    await drainIdp(r.ctx);
    expect(calls(r.fake, 'apply')).toBe(1);
    expect(roles(r, p.subject)).toEqual([]);
    expect(await auditActions(p.id)).toEqual(['idp.access_removed']);
  });

  it('removes developer, ends developer sessions only on Polaris ID, and settles the sponsorship', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    passbookAdded(r, p.subject, ['developer']);
    const sponsorId = await sponsor(r.f, org.id, p);
    await drainIdp(r.ctx);
    const dev = await session(r, p.id, ['user', 'developer']);
    const plain = await session(r, p.id, ['user']);
    const email = await session(r, p.id, ['user', 'developer'], 'magic_link');
    await run(
      env.DB,
      "UPDATE developer_sponsors SET ended_at = ?, end_reason = 'removed' WHERE id = ?",
      [r.f.clock.now(), sponsorId],
    );
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual([]);
    expect(await liveSessions(p.id)).toEqual([plain, email].sort());
    expect(await liveSessions(p.id)).not.toContain(dev);
    const [row] = await all<{ settled_at: number | null }>(
      env.DB,
      'SELECT settled_at FROM developer_sponsors WHERE id = ?',
      [sponsorId],
    );
    expect(row?.settled_at).not.toBeNull();
    expect(await auditActions(p.id)).toEqual(['idp.access_removed', 'idp.sessions_revoked']);
  });
});

describe('drain: the owner wins', () => {
  it('keeps a role the owner added, records it as external, and settles the sponsorship', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject, { roles: ['developer'] });
    const sponsorId = await sponsor(r.f, org.id, p);
    await run(
      env.DB,
      "UPDATE developer_sponsors SET ended_at = ?, end_reason = 'removed' WHERE id = ?",
      [r.f.clock.now(), sponsorId],
    );
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['developer']);
    expect(calls(r.fake, 'apply')).toBe(0);
    expect((await stateRows(p.subject)).map((s) => [s.target, s.presence])).toEqual([
      ['developer', 'external'],
    ]);
    expect(await driftKinds(p.subject)).toEqual(['external_added:developer']);
    const [row] = await all<{ settled_at: number | null }>(
      env.DB,
      'SELECT settled_at FROM developer_sponsors WHERE id = ?',
      [sponsorId],
    );
    expect(row?.settled_at).not.toBeNull();
  });

  it('holds a role the owner removed, ends the sessions that carry it, and never adds it again until Restore', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    passbookAdded(r, p.subject, ['console']);
    await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    const console_ = await session(r, p.id, ['user', 'console']);
    const plain = await session(r, p.id, ['user']);
    const email = await session(r, p.id, ['user', 'console'], 'magic_link');
    ownerRemoves(r, p.subject, 'console');
    await markDirty(env.DB, p.subject);
    await drainIdp(r.ctx);
    const [held] = await stateRows(p.subject);
    expect(held?.held_at).not.toBeNull();
    expect(await liveSessions(p.id)).toEqual([plain, email].sort());
    expect(await liveSessions(p.id)).not.toContain(console_);
    expect(await driftKinds(p.subject)).toEqual(['owner_removed:console']);
    expect(await auditActions(p.id)).toEqual(['idp.access_held', 'idp.sessions_revoked']);
    const applies = calls(r.fake, 'apply');
    for (let i = 0; i < 2; i++) {
      await markDirty(env.DB, p.subject);
      await drainIdp(r.ctx);
    }
    expect(calls(r.fake, 'apply')).toBe(applies);
    expect(roles(r, p.subject)).toEqual([]);
    expect(await clearHold(env.DB, p.subject, 'console')).toBe(true);
    await markDirty(env.DB, p.subject);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
  });

  it('applies again a grant that was never seen present, since its write may have been lost', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    r.fake.accounts.get(p.subject)?.grants.add('console');
    r.fake.accounts.get(p.subject)?.pending.add('console');
    await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    expect((await stateRows(p.subject))[0]?.held_at).toBeNull();
  });

  it('holds a confirmed grant whose role the owner took before the first drain, never adding it again', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    r.fake.accounts.get(p.subject)?.grants.add('console');
    await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual([]);
    expect(calls(r.fake, 'apply')).toBe(0);
    expect((await stateRows(p.subject))[0]?.held_at).not.toBeNull();
  });

  it('holds a grant confirmed after an earlier observed absence when the owner took the role', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    const a = r.fake.accounts.get(p.subject);
    a?.grants.add('console');
    a?.confirmedAt.set('console', 2000);
    await membership(r.f, org.id, p);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO idp_target_state (subject, target, observed, presence, observed_at)
       VALUES (?, 'console', 0, 'none', 1000)`,
    )
      .bind(p.subject)
      .run();
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual([]);
    expect(calls(r.fake, 'apply')).toBe(0);
    expect((await stateRows(p.subject))[0]?.held_at).not.toBeNull();
  });

  it('ends a grant for a role that is gone and no longer wanted, without a hold', async () => {
    const r = await rig();
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    r.fake.accounts.get(p.subject)?.grants.add('console');
    await markDirty(env.DB, p.subject);
    await drainIdp(r.ctx);
    expect(r.fake.accounts.get(p.subject)?.grants.size).toBe(0);
    expect((await stateRows(p.subject)).every((s) => s.held_at === null)).toBe(true);
  });

  it('skips platform admins without a call', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f, { lastRoles: ['admin', 'user'] });
    r.fake.addAccount(p.subject);
    await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    expect(calls(r.fake, 'lookup')).toBe(0);
    expect(roles(r, p.subject)).toEqual([]);
    expect(await dirtyRow(p.subject)).toBeNull();
  });
});

describe('drain: disabled users', () => {
  it('removes PassBook roles and disables a created account, then restores both on enable', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    passbookAdded(r, p.subject, ['console'], { class: 'created' });
    await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    await run(env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [p.id]);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual([]);
    expect(r.fake.accounts.get(p.subject)?.disabled).toBe(true);
    await run(env.DB, "UPDATE users SET status = 'active' WHERE id = ?", [p.id]);
    await drainIdp(r.ctx);
    expect(r.fake.accounts.get(p.subject)?.disabled).toBe(false);
    expect(roles(r, p.subject)).toEqual(['console']);
    expect(await auditActions(p.id)).toEqual([
      'idp.access_removed',
      'idp.account_disabled',
      'idp.account_enabled',
      'idp.access_added',
    ]);
  });

  it('adds nothing to an account the owner disabled, reports it, and ends its Polaris ID sessions', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject, { class: 'linked', disabled: true });
    await membership(r.f, org.id, p);
    await session(r, p.id, ['user', 'console']);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual([]);
    expect(await driftKinds(p.subject)).toEqual(['disabled_in_idp:console']);
    expect(await liveSessions(p.id)).toEqual([]);
  });
});

describe('drain: failures', () => {
  it('never reads a failed lookup as empty: the roles stay and the mark backs off', async () => {
    const r = await rig();
    const p = await person(r.f);
    passbookAdded(r, p.subject, ['console']);
    r.fake.failNext('IDP_UPSTREAM', 'lookup');
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    expect(calls(r.fake, 'apply')).toBe(0);
    expect(await dirtyRow(p.subject)).toMatchObject({
      attempts: 1,
      next_at: r.f.clock.now() + 60_000,
    });
    await drainIdp(r.ctx);
    expect(calls(r.fake, 'lookup')).toBe(1);
    later(r, 60_001);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual([]);
    expect(await dirtyRow(p.subject)).toBeNull();
  });

  it('stops the run on a breaker and leaves the rest due, with no backoff', async () => {
    const r = await rig({ breaker: 1 });
    const people = [];
    for (let i = 0; i < 3; i++) {
      const p = await person(r.f);
      passbookAdded(r, p.subject, ['console']);
      people.push(p);
    }
    await drainIdp(r.ctx);
    const left = people.filter((p) => roles(r, p.subject).length > 0);
    expect(left).toHaveLength(2);
    expect(calls(r.fake, 'lookup')).toBe(2);
    for (const p of left)
      expect(await dirtyRow(p.subject)).toMatchObject({ attempts: 0, next_at: 0 });
    expect(r.logs.some((l) => l.event === 'idp.drain.stopped')).toBe(true);
    expect(r.logs.some((l) => l.event === 'idp.drain.breaker' && l.code === 'IDP_BREAKER')).toBe(
      true,
    );
  });

  it('backs a subject off on a spent budget and stops the run', async () => {
    const r = await rig({ budget: { apply_add_system: 0 } });
    const org = await standardOrg(r.f);
    const people = [];
    for (let i = 0; i < 2; i++) {
      const p = await person(r.f);
      r.fake.addAccount(p.subject);
      await membership(r.f, org.id, p);
      people.push(p);
    }
    await drainIdp(r.ctx);
    expect(calls(r.fake, 'lookup')).toBe(1);
    const rows = await Promise.all(people.map((p) => dirtyRow(p.subject)));
    expect(
      rows.filter((x) => x?.attempts === 1 && x.next_at === r.f.clock.now() + 60_000),
    ).toHaveLength(1);
    expect(rows.filter((x) => x?.attempts === 0)).toHaveLength(1);
  });

  it('records a drift once, logs it with the subject, and does not retry', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    await membership(r.f, org.id, p);
    r.fake.failNext('IDP_DRIFT', 'apply');
    await drainIdp(r.ctx);
    expect(await driftKinds(p.subject)).toEqual(['apply_failed:console']);
    expect(await dirtyRow(p.subject)).toBeNull();
    expect(
      r.logs.some(
        (l) => l.event === 'idp.drain.drift' && l.code === 'IDP_DRIFT' && l.subject === p.subject,
      ),
    ).toBe(true);
    await drainIdp(r.ctx);
    expect(calls(r.fake, 'apply')).toBe(1);
  });

  it('retries after a lease conflict once the other write is done', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    await membership(r.f, org.id, p);
    r.fake.holdLease(`s:${p.subject}`);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual([]);
    expect(await dirtyRow(p.subject)).toMatchObject({ attempts: 1 });
    r.fake.releaseLease(`s:${p.subject}`);
    later(r, 60_001);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    expect(await dirtyRow(p.subject)).toBeNull();
  });

  it('keeps the other targets when Polaris ID refuses one, and records the refusal on it', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    await membership(r.f, org.id, p);
    await group(r.f, 'ghost');
    await rule(r.f, 'ghost', org.id, p.id);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    const states = await stateRows(p.subject);
    expect(states.find((s) => s.target === 'g:ghost')?.error_code).toBe('IDP_REFUSED');
    expect(await dirtyRow(p.subject)).toBeNull();
  });

  it('leaves a target alone when its group is blocked, with no call for it', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    r.fake.groupStore.set('crew', {
      kind: 'custom',
      name: 'passbook_g_crew',
      friendlyName: 'Crew',
      otherClients: 0,
      renamed: true,
    });
    await membership(r.f, org.id, p);
    await group(r.f, 'crew');
    await rule(r.f, 'crew', org.id, p.id);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    expect((await stateRows(p.subject)).find((s) => s.target === 'g:crew')?.error_code).toBe(
      'IDP_BLOCKED',
    );
  });

  it('does nothing without a binding, and nothing when Polaris ID is frozen', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    await membership(r.f, org.id, p);
    r.fake.frozen = true;
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual([]);
    expect(calls(r.fake, 'lookup')).toBe(0);
    expect(await dirtyRow(p.subject)).toMatchObject({ attempts: 0 });
    r.fake.frozen = false;
    await drainIdp({ ...r.ctx, env: Object.assign({ ...r.ctx.env }, { IDP: undefined }) });
    expect(calls(r.fake, 'lookup')).toBe(0);
  });
});

describe('drain: dry run', () => {
  it('writes differences only: no write, no hold, no session change, no audit row', async () => {
    const r = await rig({ mode: 'dry_run' });
    const org = await standardOrg(r.f);
    const wanted = await person(r.f);
    r.fake.addAccount(wanted.subject);
    await membership(r.f, org.id, wanted);
    const unwanted = await person(r.f);
    passbookAdded(r, unwanted.subject, ['console']);
    const sess = await session(r, unwanted.id, ['user', 'console']);
    await drainIdp(r.ctx);
    expect(r.fake.writes).toBe(0);
    expect(roles(r, wanted.subject)).toEqual([]);
    expect(roles(r, unwanted.subject)).toEqual(['console']);
    expect(await driftKinds(wanted.subject)).toEqual(['missing:console']);
    expect(await driftKinds(unwanted.subject)).toEqual(['unexpected:console']);
    expect(await liveSessions(unwanted.id)).toEqual([sess]);
    expect(await auditActions(wanted.id)).toEqual([]);
    expect(await auditActions(unwanted.id)).toEqual([]);
    expect(await stateRows(wanted.subject)).toEqual([]);
    expect(await stateRows(unwanted.subject)).toEqual([]);
    expect(await dirtyRow(wanted.subject)).toMatchObject({
      attempts: 0,
      next_at: r.f.clock.now() + DRY_DEFER_MS,
    });
  });

  it('leaves marks, claims and error codes alone, and looks at a mark again after a day', async () => {
    const r = await rig({ mode: 'dry_run' });
    const org = await standardOrg(r.f);
    const p = await quietPerson(r, { link: false });
    const invitation = await orgInvitation(r.f, org.id, 'invitee@example.test');
    passbookAdded(r, p.subject, ['console']);
    await claim(r.f, { org: invitation }, p.subject, r.f.clock.now() + 3000);
    await markDirty(env.DB, p.subject);
    later(r, 3001);
    await drainIdp(r.ctx);
    const [swept] = await all<{ swept_at: number | null }>(
      env.DB,
      'SELECT swept_at FROM idp_invite_claims WHERE subject = ?',
      [p.subject],
    );
    expect(swept?.swept_at).toBeNull();
    expect(await stateRows(p.subject)).toEqual([]);
    const lookups = calls(r.fake, 'lookup');
    await drainIdp(r.ctx);
    expect(calls(r.fake, 'lookup')).toBe(lookups);
    later(r, DRY_DEFER_MS);
    await drainIdp(r.ctx);
    expect(calls(r.fake, 'lookup')).toBe(lookups + 1);
    expect(r.fake.writes).toBe(0);
  });
});

describe('drain: claims', () => {
  it('takes back a claim that ended unaccepted', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await quietPerson(r, { link: false });
    const invitation = await orgInvitation(r.f, org.id, 'invitee@example.test');
    passbookAdded(r, p.subject, ['console']);
    await claim(r.f, { org: invitation }, p.subject, r.f.clock.now() + 3000);
    await markDirty(env.DB, p.subject);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    later(r, 3001);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual([]);
    const [swept] = await all<{ swept_at: number | null }>(
      env.DB,
      'SELECT swept_at FROM idp_invite_claims WHERE subject = ?',
      [p.subject],
    );
    expect(swept?.swept_at).not.toBeNull();
  });
});
