import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { countQueries } from '../../jobs/query-counter.ts';
import { run } from '../../platform/db.ts';
import { membership, person, standardOrg } from './access-test-fixtures.ts';
import { idpClient } from './client.ts';
import { drainIdp, reconcileIdp } from './jobs.ts';
import { reconcile } from './reconcile.ts';
import { dropLease, SYNC_LEASE, takeLease } from './repo-lease.ts';
import type { RunEnv } from './run-env.ts';
import {
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

const clearMarks = () => run(env.DB, 'DELETE FROM idp_dirty');
beforeEach(async () => {
  await clearMarks();
  await run(env.DB, "DELETE FROM counters WHERE key LIKE 'idp:holds:%'");
  await run(
    env.DB,
    'UPDATE users SET last_roles = \'["user"]\' WHERE last_roles LIKE \'%"admin"%\'',
  );
});

const runEnv = (r: Rig): { env: RunEnv; spent: () => number } => {
  const counter = countQueries(r.ctx.env);
  return {
    env: {
      ctx: { ...r.ctx, env: counter.env },
      rpc: idpClient(counter.env, r.ctx.log),
      runId: 'run',
      dry: false,
      blocked: new Set(),
      renew: async () => {},
    },
    spent: counter.count,
  };
};

describe('M2: holds come before the verify cap', () => {
  it('holds owner removals even when the budget ends the verification early', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const people = [];
    for (let i = 0; i < 14; i++) {
      const p = await person(r.f);
      passbookAdded(r, p.subject, ['console']);
      await membership(r.f, org.id, p);
      people.push(p);
    }
    await drainIdp(r.ctx);
    await drainIdp(r.ctx);
    await clearMarks();
    const removed = people.slice(0, 2);
    for (const p of removed) ownerRemoves(r, p.subject, 'console');
    r.f.clock.advance(1000);
    const { env: e, spent } = runEnv(r);
    const report = await reconcile(e, spent, 40);
    expect(report?.capped).toBe(true);
    expect(report?.verified).toBeLessThan(12);
    for (const p of removed) expect((await stateRows(p.subject))[0]?.held_at).not.toBeNull();
  });
});

describe('M3: every phase checks the budget', () => {
  it('stops after the snapshot with no budget', async () => {
    const r = await rig();
    const p = await person(r.f);
    r.fake.addAccount(p.subject, { roles: ['console'] });
    await clearMarks();
    const { env: e, spent } = runEnv(r);
    const report = await reconcile(e, spent, 0);
    expect(report).toMatchObject({ capped: true, members: 0 });
    expect(await driftKinds(p.subject)).toEqual([]);
  });

  it('skips the queue marks once the member scan has used the budget', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    await membership(r.f, org.id, p);
    await clearMarks();
    const small = runEnv(r);
    const capped = await reconcile(small.env, small.spent, 1);
    expect(capped).toMatchObject({ capped: true, marked: 0 });
    expect(await dirtyRow(p.subject)).toBeNull();
    const roomy = runEnv(r);
    const done = await reconcile(roomy.env, roomy.spent, 300);
    expect(done?.marked).toBe(1);
  });

  it('takes the cap from what the shared daily budget has left', async () => {
    const r = await rig();
    await reconcileIdp({ ...r.ctx, spent: () => 900 });
    expect(calls(r.fake, 'snapshot')).toBe(0);
    expect(r.logs.some((l) => l.event === 'idp.reconcile.capped' && l.phase === 'start')).toBe(
      true,
    );
    await reconcileIdp({ ...r.ctx, spent: () => 880 });
    expect(calls(r.fake, 'snapshot')).toBe(1);
  });
});

describe('M4: caps on what one reconcile acts on', () => {
  it('holds ten owner removals and only records the rest', async () => {
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
    await drainIdp(r.ctx);
    await clearMarks();
    for (const p of people) {
      ownerRemoves(r, p.subject, 'console');
      await session(r, p.id, ['user', 'console']);
    }
    await reconcileIdp(r.ctx);
    const held = (await Promise.all(people.map((p) => stateRows(p.subject)))).filter(
      ([s]) => s?.held_at != null,
    );
    expect(held).toHaveLength(10);
    let live = 0;
    for (const p of people) live += (await liveSessions(p.id)).length;
    expect(live).toBe(2);
    let reported = 0;
    for (const p of people) reported += (await driftKinds(p.subject)).length;
    expect(reported).toBe(12);
    expect(
      r.logs.some((l) => l.event === 'idp.hold_breaker' && l.code === 'IDP_HOLD_BREAKER'),
    ).toBe(true);
  });

  it('a second run finishes the members the first left, since ended ones no longer count', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const people = [];
    for (let i = 0; i < 22; i++) {
      const p = await person(r.f);
      passbookAdded(r, p.subject, ['console']);
      await membership(r.f, org.id, p);
      people.push(p);
    }
    await drainIdp(r.ctx);
    await drainIdp(r.ctx);
    await clearMarks();
    for (const p of people) {
      const a = r.fake.accounts.get(p.subject);
      if (a) a.disabled = true;
      await session(r, p.id, ['user', 'console']);
    }
    await reconcileIdp(r.ctx);
    r.logs.length = 0;
    await reconcileIdp(r.ctx);
    let live = 0;
    for (const p of people) live += (await liveSessions(p.id)).length;
    expect(live).toBe(0);
    expect(r.logs.some((l) => l.event === 'idp.hold_breaker')).toBe(false);
  });

  it('ends the sessions of twenty owner-disabled members and reports the rest', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const people = [];
    for (let i = 0; i < 22; i++) {
      const p = await person(r.f);
      passbookAdded(r, p.subject, ['console']);
      await membership(r.f, org.id, p);
      people.push(p);
    }
    await drainIdp(r.ctx);
    await drainIdp(r.ctx);
    await clearMarks();
    for (const p of people) {
      const a = r.fake.accounts.get(p.subject);
      if (a) a.disabled = true;
      await session(r, p.id, ['user', 'console']);
    }
    await reconcileIdp(r.ctx);
    let live = 0;
    let reported = 0;
    for (const p of people) {
      live += (await liveSessions(p.id)).length;
      reported += (await driftKinds(p.subject)).filter((d) =>
        d.startsWith('disabled_in_idp'),
      ).length;
    }
    expect(live).toBe(2);
    expect(reported).toBe(22);
  });
});

describe('LOW: the daily reconcile waits for the lease', () => {
  const sleeper = (r: Rig, onSleep: (n: number) => Promise<void>) => {
    let n = 0;
    return {
      ...r.ctx,
      clock: {
        now: () => r.f.clock.now(),
        sleep: async () => {
          n++;
          await onSleep(n);
        },
      },
    };
  };

  it('runs once a drain lets go of it', async () => {
    const r = await rig();
    expect(await takeLease(env.DB, SYNC_LEASE, 'drain', r.f.clock.now())).toBe(true);
    await reconcileIdp(
      sleeper(r, (n) => (n === 3 ? dropLease(env.DB, SYNC_LEASE, 'drain') : Promise.resolve())),
    );
    expect(calls(r.fake, 'snapshot')).toBe(1);
  });

  it('gives up after about ninety seconds', async () => {
    const r = await rig();
    expect(await takeLease(env.DB, SYNC_LEASE, 'drain', r.f.clock.now())).toBe(true);
    let sleeps = 0;
    await reconcileIdp(sleeper(r, async () => void sleeps++));
    expect(sleeps).toBe(18);
    expect(calls(r.fake, 'snapshot')).toBe(0);
    expect(r.logs.some((l) => l.event === 'idp.reconcile.busy')).toBe(true);
    await dropLease(env.DB, SYNC_LEASE, 'drain');
  });
});

describe('L4: platform admins are judged per person', () => {
  const group = (r: Rig, subject = 'keeper-sub') =>
    r.fake.addAccount(subject, { roles: ['platform_admin'], isAdmin: true });
  const admin = async (r: Rig) => {
    const p = await person(r.f, { lastRoles: ['admin', 'user'] });
    await session(r, p.id, ['admin', 'user']);
    return p;
  };

  it('keeps a person whose other Polaris ID account is still in the group', async () => {
    const r = await rig();
    const p = await admin(r);
    const second = `second-${p.id}`;
    await run(
      env.DB,
      "INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('pocketid', ?, ?, ?)",
      [second, p.id, r.f.clock.now()],
    );
    group(r, second);
    await clearMarks();
    await reconcileIdp(r.ctx);
    expect(await liveSessions(p.id)).toHaveLength(1);
    expect(await driftKinds(p.subject)).toEqual([]);
  });

  it('in a storm reports everyone without revoking, so the next count starts clean', async () => {
    const r = await rig();
    group(r);
    const storm = [];
    for (let i = 0; i < 7; i++) storm.push(await admin(r));
    await clearMarks();
    await reconcileIdp(r.ctx);
    for (const p of storm) {
      expect(await liveSessions(p.id)).toHaveLength(1);
      expect(await driftKinds(p.subject)).toEqual(['admin_changed:console']);
    }
    expect(r.logs.some((l) => l.event === 'idp.reconcile.admin_breaker')).toBe(true);
    const late = await admin(r);
    await clearMarks();
    r.logs.length = 0;
    await reconcileIdp(r.ctx);
    expect(await liveSessions(late.id)).toEqual([]);
    expect(r.logs.some((l) => l.event === 'idp.reconcile.admin_breaker')).toBe(false);
  });

  it('does not count a person already reported, and closes the report when they sign in again', async () => {
    const r = await rig();
    group(r);
    const first = [];
    for (let i = 0; i < 5; i++) first.push(await admin(r));
    await clearMarks();
    await reconcileIdp(r.ctx);
    for (const p of first) {
      expect(await liveSessions(p.id)).toEqual([]);
      expect(await driftKinds(p.subject)).toEqual(['admin_changed:console']);
    }
    const next = [];
    for (let i = 0; i < 3; i++) next.push(await admin(r));
    await clearMarks();
    await reconcileIdp(r.ctx);
    for (const p of next) expect(await liveSessions(p.id)).toEqual([]);
    expect(r.logs.some((l) => l.event === 'idp.reconcile.admin_breaker')).toBe(false);
    const [back] = first;
    if (!back) throw new Error('no admin');
    await run(env.DB, 'UPDATE users SET last_roles = \'["user"]\' WHERE id = ?', [back.id]);
    expect(await dirtyRow(back.subject)).not.toBeNull();
    await reconcileIdp(r.ctx);
    expect(await driftKinds(back.subject)).toEqual([]);
  });
});
