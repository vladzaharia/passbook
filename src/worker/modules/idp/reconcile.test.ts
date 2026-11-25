import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { countQueries } from '../../jobs/query-counter.ts';
import { all, run } from '../../platform/db.ts';
import { membership, person, revokeMembership, standardOrg } from './access-test-fixtures.ts';
import { idpClient } from './client.ts';
import { drainIdp, reconcileIdp } from './jobs.ts';
import { reconcile } from './reconcile.ts';
import { markDirty } from './repo-dirty.ts';
import type { RunEnv } from './run-env.ts';
import {
  auditActions,
  calls,
  dirtyRow,
  driftKinds,
  liveSessions,
  ownerRemoves,
  passbookAdded,
  type Rig,
  rig,
  session,
  stateRows,
} from './sync-test-fixtures.ts';

beforeEach(async () => {
  await run(env.DB, 'DELETE FROM idp_dirty');
  // The D1 lasts for the file: admins an earlier test made would count here.
  await run(
    env.DB,
    'UPDATE users SET last_roles = \'["user"]\' WHERE last_roles LIKE \'%"admin"%\'',
  );
});

const roles = (r: Rig, subject: string) => [...(r.fake.accounts.get(subject)?.roles ?? [])].sort();
const clearMarks = () => run(env.DB, 'DELETE FROM idp_dirty');
const adminGroup = (r: Rig) =>
  r.fake.addAccount('keeper-sub', { roles: ['platform_admin'], isAdmin: true });

describe('reconcile: what Polaris ID shows', () => {
  it('records owner-added roles as external, reports unknown members, and skips admins', async () => {
    const r = await rig();
    const p = await person(r.f);
    r.fake.addAccount(p.subject, { roles: ['console'] });
    r.fake.addAccount('ghost-sub', { roles: ['console'] });
    r.fake.addAccount('admin-sub', { roles: ['console'], isAdmin: true });
    await clearMarks();
    await reconcileIdp(r.ctx);
    expect((await stateRows(p.subject)).map((s) => [s.target, s.presence, s.observed])).toEqual([
      ['console', 'external', 1],
    ]);
    expect(await driftKinds(p.subject)).toEqual(['external_added:console']);
    expect(await driftKinds('ghost-sub')).toEqual(['unknown_member:console']);
    expect(await driftKinds('admin-sub')).toEqual([]);
    expect(calls(r.fake, 'apply')).toBe(0);
    expect(roles(r, p.subject)).toEqual(['console']);
    const again = await driftKinds(p.subject);
    await reconcileIdp(r.ctx);
    expect(await driftKinds(p.subject)).toEqual(again);
  });

  it('holds a grant the owner ended, ends its sessions, and stays the same on a second run', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    const sess = await session(r, p.id, ['user', 'console']);
    ownerRemoves(r, p.subject, 'console');
    await clearMarks();
    await reconcileIdp(r.ctx);
    expect((await stateRows(p.subject))[0]?.held_at).not.toBeNull();
    expect(await liveSessions(p.id)).not.toContain(sess);
    expect(await driftKinds(p.subject)).toEqual(['owner_removed:console']);
    const audit = await auditActions(p.id);
    await reconcileIdp(r.ctx);
    expect(await auditActions(p.id)).toEqual(audit);
    expect(roles(r, p.subject)).toEqual([]);
    await markDirty(env.DB, p.subject);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual([]);
  });

  it('only reports a disabled member, and ends the sessions of an account the owner disabled', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    passbookAdded(r, p.subject, ['console']);
    await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    await session(r, p.id, ['user', 'console']);
    const a = r.fake.accounts.get(p.subject);
    if (a) a.disabled = true;
    await clearMarks();
    await reconcileIdp(r.ctx);
    expect(await driftKinds(p.subject)).toEqual(['disabled_in_idp:console']);
    expect(await liveSessions(p.id)).toEqual([]);
  });
});

describe('reconcile: putting the drain to work', () => {
  it('marks a grant nothing wants any more, which the drain then removes', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    passbookAdded(r, p.subject, ['console']);
    const m = await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    await revokeMembership(m, r.f.clock.now());
    await clearMarks();
    await reconcileIdp(r.ctx);
    expect(await dirtyRow(p.subject)).not.toBeNull();
    expect(await driftKinds(p.subject)).toEqual(['unexpected:console']);
    expect(roles(r, p.subject)).toEqual(['console']);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual([]);
    expect(await driftKinds(p.subject)).toEqual([]);
  });

  it('marks people PassBook wants in a group and never saw', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    await membership(r.f, org.id, p);
    await clearMarks();
    await reconcileIdp(r.ctx);
    expect(await dirtyRow(p.subject)).not.toBeNull();
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    await reconcileIdp(r.ctx);
    expect(await dirtyRow(p.subject)).toBeNull();
  });

  it('a dry-run week lists what is missing without queuing it, then live runs apply it', async () => {
    const r = await rig({ mode: 'dry_run' });
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    await membership(r.f, org.id, p);
    await clearMarks();
    await reconcileIdp(r.ctx);
    expect(await driftKinds(p.subject)).toEqual(['missing:console']);
    expect(await dirtyRow(p.subject)).toBeNull();
    expect(await stateRows(p.subject)).toEqual([]);
    expect(r.fake.writes).toBe(0);
    r.fake.mode = 'live';
    await reconcileIdp(r.ctx);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    expect(await driftKinds(p.subject)).toEqual([]);
  });

  it('does nothing while Polaris ID is frozen', async () => {
    const r = await rig();
    r.fake.frozen = true;
    await reconcileIdp(r.ctx);
    expect(calls(r.fake, 'snapshot')).toBe(0);
  });
});

describe('reconcile: platform admins', () => {
  it('ends the admin sessions of someone the owner took out of the group', async () => {
    const r = await rig();
    const p = await person(r.f, { lastRoles: ['admin', 'user', 'developer', 'console'] });
    r.fake.addAccount(p.subject);
    adminGroup(r);
    const sess = await session(r, p.id, ['admin', 'user', 'console']);
    const email = await session(r, p.id, ['user'], 'magic_link');
    await clearMarks();
    await reconcileIdp(r.ctx);
    expect(await liveSessions(p.id)).toEqual([email]);
    expect(await liveSessions(p.id)).not.toContain(sess);
    expect(await driftKinds(p.subject)).toEqual(['admin_changed:console']);
  });

  it('revokes nothing when the group reads empty or many admins vanish at once', async () => {
    const r = await rig();
    const admins = [];
    for (let i = 0; i < 7; i++) {
      const p = await person(r.f, { lastRoles: ['admin', 'user'] });
      await session(r, p.id, ['admin', 'user']);
      admins.push(p);
    }
    await clearMarks();
    await reconcileIdp(r.ctx);
    for (const p of admins) expect(await liveSessions(p.id)).toHaveLength(1);
    adminGroup(r);
    await reconcileIdp(r.ctx);
    for (const p of admins) expect(await liveSessions(p.id)).toHaveLength(1);
    expect(r.logs.some((l) => l.event === 'idp.reconcile.admin_breaker')).toBe(true);
  });
});

describe('reconcile: dry run', () => {
  it('records differences only', async () => {
    const r = await rig({ mode: 'dry_run' });
    const p = await person(r.f, { lastRoles: ['admin', 'user'] });
    const q = await person(r.f);
    r.fake.addAccount(q.subject, { roles: ['console'] });
    const sess = await session(r, p.id, ['admin', 'user']);
    adminGroup(r);
    await clearMarks();
    await reconcileIdp(r.ctx);
    expect(await liveSessions(p.id)).toEqual([sess]);
    expect(await driftKinds(p.subject)).toEqual(['admin_changed:console']);
    expect(await driftKinds(q.subject)).toEqual(['external_added:console']);
    expect(r.fake.writes).toBe(0);
  });
});

describe('reconcile: budget', () => {
  it('verifies the longest unchecked first and carries on the next day, within its query cap', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const people = [];
    for (let i = 0; i < 12; i++) {
      const p = await person(r.f);
      passbookAdded(r, p.subject, ['console']);
      await membership(r.f, org.id, p);
      people.push(p);
    }
    await drainIdp(r.ctx);
    await clearMarks();
    r.f.clock.advance(1000);
    const counter = countQueries(r.ctx.env);
    const run1: RunEnv = {
      ctx: { ...r.ctx, env: counter.env },
      rpc: idpClient(counter.env, r.ctx.log),
      runId: 'run-1',
      dry: false,
      blocked: new Set(),
      renew: async () => {},
    };
    const first = await reconcile(run1, counter.count, 40);
    expect(first?.capped).toBe(true);
    expect(first?.verified).toBeGreaterThan(0);
    expect(first?.verified).toBeLessThan(12);
    // The cap is a stop-starting line: one subject's checks may finish past it, never a whole backlog.
    expect(counter.count()).toBeLessThan(40 + 20);
    const touched = async () =>
      (
        await all<{ subject: string }>(
          env.DB,
          'SELECT DISTINCT subject FROM idp_target_state WHERE observed_at >= ?',
          [r.f.clock.now()],
        )
      ).map((x) => x.subject);
    const seen = new Set(await touched());
    for (let day = 1; day <= 12 && seen.size < 12; day++) {
      r.f.clock.advance(86_400_000);
      const c = countQueries(r.ctx.env);
      const out = await reconcile(
        { ...run1, ctx: { ...run1.ctx, env: c.env }, runId: `run-d${day}` },
        c.count,
        40,
      );
      expect(out).not.toBeNull();
      for (const x of await touched()) seen.add(x);
      if (!out?.capped) break;
    }
    for (const p of people) expect((await stateRows(p.subject))[0]?.observed_at).not.toBeNull();
    expect(seen.size).toBe(12);
  });

  it('first sight of many members costs a few queries, not one per member', async () => {
    const r = await rig();
    for (let i = 0; i < 60; i++) {
      const p = await person(r.f);
      r.fake.addAccount(p.subject, { roles: ['console'] });
    }
    await clearMarks();
    const counter = countQueries(r.ctx.env);
    const out = await reconcile(
      {
        ctx: { ...r.ctx, env: counter.env },
        rpc: idpClient(counter.env, r.ctx.log),
        runId: 'run-big',
        dry: false,
        blocked: new Set(),
        renew: async () => {},
      },
      counter.count,
      300,
    );
    expect(out?.external).toBe(60);
    expect(counter.count()).toBeLessThan(40);
  });
});
