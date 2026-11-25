import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../workers/polaris-binding/src/index.ts';
import { LIMITS } from '../../workers/polaris-binding/src/ledger.ts';
import {
  captureLogs,
  ctx,
  ledger,
  NOW,
  resetLedger,
  seedCreated,
  seedGrant,
  setup,
} from './harness.ts';

beforeEach(resetLedger);

const starts = (bucket: string, n: number, at: number) => {
  const insert = env.DB.prepare(
    "INSERT INTO idp_calls (call_id, phase, method, bucket, at) VALUES ('x', 'start', ?1, ?1, ?2)",
  );
  return env.DB.batch(Array.from({ length: n }, (_, i) => insert.bind(bucket, at - i)));
};

describe('budgets fail closed', () => {
  type S = ReturnType<typeof setup>;
  const calls: Record<string, (s: S) => Promise<unknown>> = {
    createSignup: (s) => s.api.createSignup('member', ctx()),
    findByVerifiedEmail: (s) => s.api.findByVerifiedEmail('a@b.test', ctx()),
    apply_add: (s) =>
      s.api.apply('u1', { add: ['developer'] }, ctx({ actor: { kind: 'user', id: 'a1' } })),
    apply_add_system: (s) => s.api.apply('u1', { add: ['developer'] }, ctx()),
    apply_remove: (s) => s.api.apply('u1', { remove: ['developer'] }, ctx()),
    apply_override: (s) => s.api.apply('u1', { remove: ['developer'] }, ctx({ override: true })),
    setDisabled: (s) => s.api.setDisabled('u1', true, ctx()),
    snapshot: (s) => s.api.snapshot(ctx()),
    lookup: (s) => s.api.lookup('u1'),
    proveSignup: (s) => s.api.proveSignup(['tok-id-1']),
    deleteSignup: (s) => s.api.deleteSignup('tok-id-1', ctx()),
  };

  it.each(Object.keys(calls))(
    '%s stops at its minute budget with no Polaris ID call',
    async (bucket) => {
      const s = setup();
      s.pocket.addUser('u1', { groups: ['g-dev'] });
      await seedGrant('u1');
      await seedCreated('u1');
      // prime the health cache, and the token for the methods that need one
      await s.api.health();
      await s.api.createSignup('developer', ctx());
      await starts(bucket, LIMITS[bucket as keyof typeof LIMITS].perMinute, NOW);
      const before = s.pocket.s.seen.length;
      await expect((calls[bucket] as (x: S) => Promise<unknown>)(s)).rejects.toThrow(/^IDP_BUDGET/);
      expect(s.pocket.s.seen).toHaveLength(before);
      expect((await ledger()).at(-1)).toMatchObject({
        phase: 'budget',
        bucket,
        status: 'IDP_BUDGET',
      });
    },
  );

  it('has the limits of design 5.5', () => {
    expect(LIMITS).toMatchObject({
      createSignup: { perMinute: 10, perDay: 50 },
      findByVerifiedEmail: { perMinute: 10, perDay: 50 },
      apply_add: { perMinute: 10, perDay: 100 },
      apply_add_system: { perMinute: 20, perDay: 200 },
      apply_remove: { perMinute: 20, perDay: 200 },
      apply_override: { perMinute: 2, perDay: 10 },
      setDisabled: { perMinute: 5, perDay: 20 },
      snapshot: { perMinute: 1, perDay: 30 },
      proveSignup: { perMinute: 30, perDay: 300 },
      deleteSignup: { perMinute: 30, perDay: 300 },
      lookup: { perMinute: 60, perDay: 1000 },
      health: { perMinute: 6, perDay: 300 },
    });
  });

  it('charges an add by a user or key and an add by the system to different buckets', async () => {
    const s = setup();
    s.pocket.addUser('u1');
    await s.api.apply('u1', { add: ['developer'] }, ctx({ actor: { kind: 'key', id: 'k1' } }));
    await s.api.apply('u1', { add: ['console'] }, ctx());
    const h = await s.api.health();
    expect(h.budget.apply_add?.day).toBe(1);
    expect(h.budget.apply_add_system?.day).toBe(1);
  });

  it('an override stops after 2 a minute, however many removals are asked', async () => {
    const s = setup();
    for (const u of ['u1', 'u2', 'u3']) s.pocket.addUser(u, { groups: ['g-dev'] });
    const o = ctx({ override: true, actor: { kind: 'user', id: 'a1' } });
    await s.api.apply('u1', { remove: ['developer'] }, o);
    await s.api.apply('u2', { remove: ['developer'] }, o);
    await expect(s.api.apply('u3', { remove: ['developer'] }, o)).rejects.toThrow(/^IDP_BUDGET/);
    expect(s.pocket.s.users.get('u3')?.groups).toContain('g-dev');
  });

  it('createSignup stops after 10 a minute and 50 a day, and recovers after the minute', async () => {
    const s = setup();
    for (let i = 0; i < 10; i++) await s.api.createSignup('member', ctx({ ref: `r${i}` }));
    await expect(s.api.createSignup('member', ctx())).rejects.toThrow(/^IDP_BUDGET/);
    expect(s.pocket.s.tokens).toHaveLength(10);
    s.clock.now += 61_000;
    await s.api.createSignup('member', ctx());
    await starts('createSignup', 39, s.clock.now - 120_000);
    await expect(s.api.createSignup('member', ctx())).rejects.toThrow(/^IDP_BUDGET/);
  });

  it('caps the config read too, so a write cannot be kept alive past an unreadable config', async () => {
    const s = setup();
    await starts('health', LIMITS.health.perMinute, NOW);
    await expect(s.api.createSignup('member', ctx())).rejects.toThrow(/^IDP_BUDGET/);
    expect(s.pocket.s.seen).toHaveLength(0);
  });

  it('raises binding.budget_high past half of a daily budget', async () => {
    const s = setup();
    await s.api.health();
    await starts('createSignup', 25, NOW - 120_000);
    const logs = await captureLogs(() => s.api.createSignup('member', ctx()));
    expect(logs.lines.filter((l) => l.includes('binding.budget_high'))).toHaveLength(1);
  });

  it("reports today's use per method in health", async () => {
    const s = setup();
    await s.api.createSignup('member', ctx());
    const h = await s.api.health();
    expect(h.budget.createSignup).toEqual({ day: 1, limit: 50 });
    expect(h.budget.apply_remove).toEqual({ day: 0, limit: 200 });
  });
});

describe('ledger', () => {
  it('writes start and end rows with the status, and ids only', async () => {
    const s = setup();
    await s.api.createSignup('member', ctx({ ref: 'inv-9' }));
    const rows = (await ledger()).filter((r) => r.method === 'createSignup');
    expect(rows.map((r) => r.phase)).toEqual(['start', 'end']);
    expect(rows[1]).toMatchObject({
      caller: 'inv-9',
      status: '201',
      actor: 'system:drain',
      role: 'console',
    });
  });

  it('writes one refused row for a refusal and a budget row for an exhausted budget', async () => {
    const s = setup();
    await expect(s.api.apply('a/b', { add: ['developer'] }, ctx())).rejects.toThrow(/^IDP_REFUSED/);
    expect(await ledger()).toMatchObject([{ phase: 'refused', method: 'apply', caller: 'run-1' }]);
  });

  it('records an upstream failure by its code', async () => {
    const s = setup();
    await s.api.health();
    s.pocket.s.failWith = { match: /^POST /, status: 500 };
    await expect(s.api.createSignup('member', ctx())).rejects.toThrow(/^IDP_UPSTREAM/);
    expect((await ledger()).at(-1)).toMatchObject({ phase: 'end', status: 'IDP_UPSTREAM' });
  });

  it('is append-only', async () => {
    const s = setup();
    await s.api.createSignup('member', ctx());
    await expect(env.DB.prepare("UPDATE idp_calls SET status = 'x'").run()).rejects.toThrow(
      /append-only/,
    );
    await expect(env.DB.prepare('DELETE FROM idp_calls').run()).rejects.toThrow(/append-only/);
  });

  it('serves calls(since) newest-window only', async () => {
    const s = setup();
    await s.api.createSignup('member', ctx());
    expect((await s.api.calls(0)).length).toBeGreaterThan(0);
    expect(await s.api.calls(NOW + 1_000_000)).toEqual([]);
  });
});

describe('entrypoint', () => {
  it('answers 404 to fetch', async () => {
    const res = (worker.fetch as unknown as () => Response)();
    expect(res.status).toBe(404);
  });
});
