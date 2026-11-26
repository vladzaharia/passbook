import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { bump } from '../../platform/counters.ts';
import { all, first, run } from '../../platform/db.ts';
import { purgeExpired } from '../auth/repo.ts';
import { membership, person, sandboxOrg, sponsor, standardOrg } from './access-test-fixtures.ts';
import { DRAIN_BATCH, drainIdp, reconcileIdp } from './jobs.ts';
import { markDirty } from './repo-dirty.ts';
import { dropLease, LEASE_TTL_MS, SYNC_LEASE, takeLease } from './repo-lease.ts';
import { holdTarget, recordObserved } from './repo-state.ts';
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
import type { Target } from './types.ts';

beforeEach(async () => {
  await run(env.DB, 'DELETE FROM idp_dirty');
  await run(env.DB, "DELETE FROM counters WHERE key LIKE 'idp:holds:%'");
});

const roles = (r: Rig, subject: string) => [...(r.fake.accounts.get(subject)?.roles ?? [])].sort();
const later = (r: Rig, ms: number) => r.f.clock.advance(ms);
const settledAt = async (id: string) =>
  (
    await first<{ settled_at: number | null }>(
      env.DB,
      'SELECT settled_at FROM developer_sponsors WHERE id = ?',
      [id],
    )
  )?.settled_at;

/** A developer who holds the role through a sponsorship and has a developer sandbox with a membership. */
async function developerWithSandbox(r: Rig, added: Target[] = ['developer', 'console']) {
  const org = await standardOrg(r.f);
  const sandbox = await sandboxOrg(r.f);
  const p = await person(r.f);
  passbookAdded(r, p.subject, added);
  const sponsorId = await sponsor(r.f, org.id, p);
  await run(
    env.DB,
    'INSERT INTO developer_sandboxes (id, org_id, user_id, created_at) VALUES (?, ?, ?, ?)',
    [r.f.ids.id(), sandbox.id, p.id, r.f.clock.now()],
  );
  await membership(r.f, sandbox.id, p);
  const end = () =>
    run(env.DB, "UPDATE developer_sponsors SET ended_at = ?, end_reason = 'removed' WHERE id = ?", [
      r.f.clock.now(),
      sponsorId,
    ]);
  return { p, sandbox, sponsorId, end };
}

const sandboxState = async (orgId: string) =>
  first<{ status: string; closed_at: number | null }>(
    env.DB,
    'SELECT o.status, d.closed_at FROM orgs o JOIN developer_sandboxes d ON d.org_id = o.id WHERE o.id = ?',
    [orgId],
  );

describe('H1: taking developer back closes the sandbox', () => {
  it('closes it in the same run, console follows from the org change, sponsorship settles after', async () => {
    const r = await rig();
    const { p, sandbox, sponsorId, end } = await developerWithSandbox(r);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console', 'developer']);
    await end();
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    expect(await sandboxState(sandbox.id)).toMatchObject({ status: 'deleted' });
    expect((await sandboxState(sandbox.id))?.closed_at).not.toBeNull();
    expect(await settledAt(sponsorId)).not.toBeNull();
    expect(await dirtyRow(p.subject)).not.toBeNull();
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual([]);
  });

  it('keeps the sandbox while another reason wants developer', async () => {
    const r = await rig();
    const { p, sandbox, end } = await developerWithSandbox(r);
    const other = await standardOrg(r.f);
    await sponsor(r.f, other.id, p);
    await drainIdp(r.ctx);
    await end();
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toContain('developer');
    expect((await sandboxState(sandbox.id))?.closed_at).toBeNull();
  });

  it('settles nothing and tries the close again when it fails', async () => {
    const r = await rig();
    const { p, sandbox, sponsorId, end } = await developerWithSandbox(r);
    await drainIdp(r.ctx);
    await run(
      env.DB,
      `CREATE TRIGGER block_close BEFORE UPDATE OF status ON orgs WHEN NEW.status = 'deleted'
       BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    await end();
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    expect((await sandboxState(sandbox.id))?.closed_at).toBeNull();
    expect(await settledAt(sponsorId)).toBeNull();
    expect((await stateRows(p.subject)).find((s) => s.target === 'developer')?.error_code).toBe(
      'SANDBOX_CLOSE_FAILED',
    );
    expect(await dirtyRow(p.subject)).toMatchObject({ attempts: 1 });
    await run(env.DB, 'DROP TRIGGER block_close');
    later(r, 61_000);
    await drainIdp(r.ctx);
    expect((await sandboxState(sandbox.id))?.closed_at).not.toBeNull();
    expect(await settledAt(sponsorId)).not.toBeNull();
    expect(
      (await stateRows(p.subject)).find((s) => s.target === 'developer')?.error_code,
    ).toBeNull();
  });
});

describe('H1 residual: the sandbox follows state, not only a removal in the run', () => {
  it('closes it when a held developer role loses its last reason', async () => {
    const r = await rig();
    const { p, sandbox, sponsorId, end } = await developerWithSandbox(r, ['console']);
    await holdTarget(env.DB, p.subject, 'developer', p.id, r.f.clock.now());
    await drainIdp(r.ctx);
    expect((await sandboxState(sandbox.id))?.closed_at).toBeNull();
    await end();
    await drainIdp(r.ctx);
    expect(calls(r.fake, 'apply')).toBe(0);
    expect((await sandboxState(sandbox.id))?.closed_at).not.toBeNull();
    expect(await settledAt(sponsorId)).not.toBeNull();
  });

  it('closes it when developer was never present and nothing wants it', async () => {
    const r = await rig();
    const org = await sandboxOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    await run(
      env.DB,
      'INSERT INTO developer_sandboxes (id, org_id, user_id, created_at) VALUES (?, ?, ?, ?)',
      [r.f.ids.id(), org.id, p.id, r.f.clock.now()],
    );
    await membership(r.f, org.id, p);
    await recordObserved(env.DB, {
      subject: p.subject,
      target: 'developer',
      userId: p.id,
      observed: false,
      presence: 'none',
      now: r.f.clock.now(),
    });
    await drainIdp(r.ctx);
    expect((await sandboxState(org.id))?.closed_at).not.toBeNull();
  });

  it('leaves the sandbox of someone who never had a developer state alone', async () => {
    const r = await rig();
    const org = await sandboxOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    await run(
      env.DB,
      'INSERT INTO developer_sandboxes (id, org_id, user_id, created_at) VALUES (?, ?, ?, ?)',
      [r.f.ids.id(), org.id, p.id, r.f.clock.now()],
    );
    await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    expect((await sandboxState(org.id))?.closed_at).toBeNull();
  });
});

describe('M2: an owner role the owner took back is held', () => {
  it('holds a role PassBook saw present without adding it, and never adds it back', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject, { roles: ['console'] });
    await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    expect((await stateRows(p.subject))[0]?.presence).toBe('external');
    ownerRemoves(r, p.subject, 'console');
    await markDirty(env.DB, p.subject);
    await drainIdp(r.ctx);
    expect((await stateRows(p.subject))[0]?.held_at).not.toBeNull();
    expect(calls(r.fake, 'apply')).toBe(0);
    expect(roles(r, p.subject)).toEqual([]);
  });
});

describe('L2: a grant never seen present goes in again, loudly', () => {
  it('logs the re-add with the subject', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    r.fake.accounts.get(p.subject)?.grants.add('console');
    await membership(r.f, org.id, p);
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    expect(
      r.logs.some(
        (l) =>
          l.event === 'idp.access_readded' && l.code === 'IDP_READDED' && l.subject === p.subject,
      ),
    ).toBe(true);
  });
});

describe('M4: the breaker ref is per hour, and holds are capped', () => {
  it('sends one ref for an hour and another for the next', async () => {
    const r = await rig();
    const refs: string[] = [];
    const apply = r.fake.apply.bind(r.fake);
    r.fake.apply = async (s, d, c) => {
      refs.push(c.ref);
      return apply(s, d, c);
    };
    const org = await standardOrg(r.f);
    for (const wait of [30 * 60_000, 31 * 60_000, 0]) {
      const p = await person(r.f);
      r.fake.addAccount(p.subject);
      await membership(r.f, org.id, p);
      await drainIdp(r.ctx);
      later(r, wait);
    }
    expect(refs).toHaveLength(3);
    expect(refs[1]).toBe(refs[0]);
    expect(refs[0]).toMatch(/^sync-\d+$/);
    expect(refs[2]).not.toBe(refs[0]);
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(refs[0] ?? '')).toBe(true);
  });

  it('holds ten owner removals in a run and only records the rest, with their sessions kept', async () => {
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
    for (const p of people) {
      ownerRemoves(r, p.subject, 'console');
      await session(r, p.id, ['user', 'console']);
      await markDirty(env.DB, p.subject);
    }
    await drainIdp(r.ctx);
    const held = (await Promise.all(people.map((p) => stateRows(p.subject)))).filter(
      ([s]) => s?.held_at != null,
    );
    expect(held).toHaveLength(10);
    let kept = 0;
    for (const p of people) kept += (await liveSessions(p.id)).length;
    expect(kept).toBe(2);
    let reported = 0;
    for (const p of people) reported += (await driftKinds(p.subject)).length;
    expect(reported).toBe(12);
    expect(
      r.logs.some((l) => l.event === 'idp.hold_breaker' && l.code === 'IDP_HOLD_BREAKER'),
    ).toBe(true);
  });
});

describe('LOW: holds are counted per hour, across runs', () => {
  it('holds ten in an hour even when they arrive in different minutes', async () => {
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
    for (const batch of [people.slice(0, 6), people.slice(6)]) {
      for (const p of batch) {
        ownerRemoves(r, p.subject, 'console');
        await markDirty(env.DB, p.subject);
      }
      await drainIdp(r.ctx);
      later(r, 10 * 60_000);
    }
    const held = (await Promise.all(people.map((p) => stateRows(p.subject)))).filter(
      ([s]) => s?.held_at != null,
    );
    expect(held).toHaveLength(10);
  });
});

describe('LOW: hold counters are pruned by the daily counter sweep', () => {
  it('drops an old hour and keeps the current one', async () => {
    const hour = Math.floor(Date.now() / 3_600_000);
    const now = hour * 3_600_000;
    await bump(env.DB, `idp:holds:${hour - 72}`, (hour - 72) * 3_600_000);
    await bump(env.DB, `idp:holds:${hour}`, now);
    await purgeExpired(env.DB, now);
    const keys = await all<{ key: string }>(
      env.DB,
      "SELECT key FROM counters WHERE key LIKE 'idp:holds:%'",
    );
    expect(keys.map((k) => k.key)).toEqual([`idp:holds:${hour}`]);
  });
});

describe('L5: one sync run at a time, and per-target cost counts', () => {
  it('skips while another run holds the lease, runs once it is free or has expired', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    await membership(r.f, org.id, p);
    expect(await takeLease(env.DB, SYNC_LEASE, 'other', r.f.clock.now())).toBe(true);
    await drainIdp(r.ctx);
    await reconcileIdp(r.ctx);
    expect(calls(r.fake, 'lookup')).toBe(0);
    expect(calls(r.fake, 'snapshot')).toBe(0);
    expect(r.logs.some((l) => l.event === 'idp.drain.busy')).toBe(true);
    expect(r.logs.some((l) => l.event === 'idp.reconcile.busy')).toBe(true);
    await dropLease(env.DB, SYNC_LEASE, 'other');
    await drainIdp(r.ctx);
    expect(roles(r, p.subject)).toEqual(['console']);
    expect(await all(env.DB, 'SELECT 1 FROM idp_run_lease WHERE name = ?', [SYNC_LEASE])).toEqual(
      [],
    );
    expect(await takeLease(env.DB, SYNC_LEASE, 'stale', r.f.clock.now())).toBe(true);
    expect(await takeLease(env.DB, SYNC_LEASE, 'late', r.f.clock.now() + LEASE_TTL_MS - 1)).toBe(
      false,
    );
    expect(await takeLease(env.DB, SYNC_LEASE, 'late', r.f.clock.now() + LEASE_TTL_MS)).toBe(true);
    await dropLease(env.DB, SYNC_LEASE, 'late');
  });

  it('frees the lease when a run fails', async () => {
    const r = await rig();
    const p = await person(r.f);
    r.fake.addAccount(p.subject);
    r.fake.failNext('IDP_UPSTREAM', 'health');
    await drainIdp(r.ctx);
    expect(await all(env.DB, 'SELECT 1 FROM idp_run_lease WHERE name = ?', [SYNC_LEASE])).toEqual(
      [],
    );
  });

  it('stops a run when the targets it has looked at reach the cap', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    const people = [];
    for (let i = 0; i < 3; i++) {
      const p = await person(r.f);
      r.fake.addAccount(p.subject);
      await membership(r.f, org.id, p);
      people.push(p);
    }
    await drainIdp(r.ctx, 250, 2);
    const done = people.filter((p) => roles(r, p.subject).length > 0);
    expect(done).toHaveLength(2);
    expect(r.logs.some((l) => l.event === 'idp.drain.capped' && l.left === 1)).toBe(true);
    expect(DRAIN_BATCH).toBe(20);
  });
});

describe('LOW: the lease is renewed after each subject', () => {
  it('stays taken for a run that outlasts its first five minutes', async () => {
    const r = await rig();
    const org = await standardOrg(r.f);
    for (let i = 0; i < 3; i++) {
      const p = await person(r.f);
      r.fake.addAccount(p.subject);
      await membership(r.f, org.id, p);
    }
    const lookup = r.fake.lookup.bind(r.fake);
    const seen: boolean[] = [];
    r.fake.lookup = async (s) => {
      r.f.clock.advance(4 * 60_000);
      seen.push(await takeLease(env.DB, SYNC_LEASE, 'rival', r.f.clock.now()));
      return lookup(s);
    };
    await drainIdp(r.ctx);
    expect(seen).toEqual([false, false, false]);
  });
});
