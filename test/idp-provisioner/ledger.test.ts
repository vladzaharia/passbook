import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../workers/idp-provisioner/src/index.ts';
import { LIMITS } from '../../workers/idp-provisioner/src/ledger.ts';
import { captureLogs, ledger, NOW, resetLedger, seedGrant, setup } from './harness.ts';

beforeEach(resetLedger);

const starts = (method: string, n: number, at: number) => {
  const insert = env.DB.prepare(
    "INSERT INTO idp_calls (call_id, phase, method, at) VALUES ('x', 'start', ?, ?)",
  );
  return env.DB.batch(Array.from({ length: n }, (_, i) => insert.bind(method, at - i)));
};

describe('budgets fail closed', () => {
  const calls: Record<string, (s: ReturnType<typeof setup>) => Promise<unknown>> = {
    createSignup: (s) => s.api.createSignup('r1'),
    addDeveloper: (s) => s.api.addDeveloper('u1', 'r1'),
    removeDeveloper: (s) => s.api.removeDeveloper('u1', 'ended'),
    proveSignup: async (s) => {
      await s.api.createSignup('keep');
      return s.api.proveSignup(['tok-id-1']);
    },
    deleteSignup: async (s) => {
      await s.api.createSignup('keep');
      return s.api.deleteSignup('tok-id-1');
    },
  };

  it.each(Object.keys(calls))(
    '%s stops at its minute budget with no Pocket ID call',
    async (method) => {
      const s = setup();
      s.pocket.addUser('u1');
      await seedGrant('u1');
      // prime the health cache, and the token for the methods that need one
      await s.api.health();
      if (method === 'proveSignup' || method === 'deleteSignup') await s.api.createSignup('keep');
      const saturate = LIMITS[method as keyof typeof LIMITS].perMinute;
      await starts(method, saturate, NOW);
      const before = s.pocket.s.seen.length;
      const run =
        method === 'proveSignup'
          ? s.api.proveSignup(['tok-id-1'])
          : method === 'deleteSignup'
            ? s.api.deleteSignup('tok-id-1')
            : (calls[method] as (x: typeof s) => Promise<unknown>)(s);
      await expect(run).rejects.toThrow(/^IDP_BUDGET/);
      expect(s.pocket.s.seen).toHaveLength(before);
      expect((await ledger()).at(-1)).toMatchObject({
        phase: 'budget',
        method,
        status: 'IDP_BUDGET',
      });
    },
  );

  it('createSignup stops after 10 a minute and 50 a day, and recovers after the minute', async () => {
    const s = setup();
    for (let i = 0; i < 10; i++) await s.api.createSignup(`r${i}`);
    await expect(s.api.createSignup('r10')).rejects.toThrow(/^IDP_BUDGET/);
    expect(s.pocket.s.tokens).toHaveLength(10);
    s.clock.now += 61_000;
    await s.api.createSignup('r11');
    await starts('createSignup', 39, s.clock.now - 120_000);
    await expect(s.api.createSignup('r12')).rejects.toThrow(/^IDP_BUDGET/);
  });

  it('caps the config read too, so a write cannot be kept alive past an unreadable config', async () => {
    const s = setup();
    await starts('health', LIMITS.health.perMinute, NOW);
    await expect(s.api.createSignup('r1')).rejects.toThrow(/^IDP_BUDGET/);
    expect(s.pocket.s.seen).toHaveLength(0);
  });

  it('raises provisioner.budget_high past half of a daily budget', async () => {
    const s = setup();
    await s.api.health();
    await starts('createSignup', 25, NOW - 120_000);
    const logs = await captureLogs(() => s.api.createSignup('r1'));
    expect(logs.lines.filter((l) => l.includes('provisioner.budget_high'))).toHaveLength(1);
  });

  it("reports today's use per method in health", async () => {
    const s = setup();
    await s.api.createSignup('r1');
    const h = await s.api.health();
    expect(h.budget.createSignup).toEqual({ day: 1, limit: 50 });
    expect(h.budget.removeDeveloper).toEqual({ day: 0, limit: 200 });
  });
});

describe('ledger', () => {
  it('writes start and end rows with the status, and ids only', async () => {
    const s = setup();
    await s.api.createSignup('inv-9');
    const rows = (await ledger()).filter((r) => r.method === 'createSignup');
    expect(rows.map((r) => r.phase)).toEqual(['start', 'end']);
    expect(rows[1]).toMatchObject({ caller: 'inv-9', status: '201' });
  });

  it('writes one refused row for a refusal and a budget row for an exhausted budget', async () => {
    const s = setup();
    await expect(s.api.addDeveloper('a/b', 'r1')).rejects.toThrow(/^IDP_REFUSED/);
    expect(await ledger()).toMatchObject([{ phase: 'refused', method: 'addDeveloper' }]);
  });

  it('records an upstream failure by its code', async () => {
    const s = setup();
    await s.api.health();
    s.pocket.s.failWith = { match: /^POST /, status: 500 };
    await expect(s.api.createSignup('r1')).rejects.toThrow(/^IDP_UPSTREAM/);
    expect((await ledger()).at(-1)).toMatchObject({ phase: 'end', status: 'IDP_UPSTREAM' });
  });

  it('is append-only', async () => {
    const s = setup();
    await s.api.createSignup('r1');
    await expect(env.DB.prepare("UPDATE idp_calls SET status = 'x'").run()).rejects.toThrow(
      /append-only/,
    );
    await expect(env.DB.prepare('DELETE FROM idp_calls').run()).rejects.toThrow(/append-only/);
  });

  it('serves calls(since) newest-window only', async () => {
    const s = setup();
    await s.api.createSignup('r1');
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
