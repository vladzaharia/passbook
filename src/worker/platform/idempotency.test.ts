import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.ts';
import { first } from './db.ts';
import type { AppEnv } from './env.ts';
import {
  IDEMPOTENCY_TTL_MS,
  type IdempotencyScope,
  sweepIdempotency,
  withIdempotency,
} from './idempotency.ts';
import { createServiceContext } from './service-context.ts';

const e = env as AppEnv;

function setup() {
  const clock = new ManualClock(1_800_000_000_000);
  const ctx = createServiceContext(e, { clock });
  const scope = (
    over: Partial<IdempotencyScope> = {},
    body: unknown = { a: 1 },
  ): IdempotencyScope => ({
    orgId: 'org-a',
    mode: 'live',
    principal: 'key:k1',
    operation: 'POST /passes',
    key: 'default',
    request: { method: 'POST', path: '/passes', body },
    ...over,
  });
  return { clock, ctx, scope };
}

describe('withIdempotency', () => {
  it('replays the stored response without running again', async () => {
    const { ctx, scope } = setup();
    const s = scope({ key: 'replay' });
    let runs = 0;
    const exec = async () => ({ status: 201, body: { id: ++runs } });
    const first1 = await withIdempotency(ctx, s, exec);
    const second = await withIdempotency(ctx, s, exec);
    expect(first1).toEqual({ status: 201, body: { id: 1 }, replayed: false });
    expect(second).toEqual({ status: 201, body: { id: 1 }, replayed: true });
    expect(runs).toBe(1);
  });

  it('treats key order in the body as the same request', async () => {
    const { ctx, scope } = setup();
    await withIdempotency(ctx, scope({ key: 'order' }, { a: 1, b: 2 }), async () => ({
      status: 200,
      body: 1,
    }));
    const again = await withIdempotency(ctx, scope({ key: 'order' }, { b: 2, a: 1 }), async () => ({
      status: 200,
      body: 2,
    }));
    expect(again.replayed).toBe(true);
  });

  it('rejects the same key with another body as 422', async () => {
    const { ctx, scope } = setup();
    await withIdempotency(ctx, scope({ key: 'mismatch' }, { a: 1 }), async () => ({
      status: 200,
      body: 1,
    }));
    await expect(
      withIdempotency(ctx, scope({ key: 'mismatch' }, { a: 2 }), async () => ({
        status: 200,
        body: 2,
      })),
    ).rejects.toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('never shares a key between principals, orgs, modes or operations', async () => {
    const { ctx, scope } = setup();
    let runs = 0;
    const exec = async () => ({ status: 200, body: ++runs });
    const variants: Partial<IdempotencyScope>[] = [
      { principal: 'key:k1' },
      { principal: 'key:k2' },
      { principal: 'session:u1' },
      { orgId: 'org-b' },
      { mode: 'test' },
      { operation: 'POST /passes/{id}/resend-email' },
    ];
    for (const v of variants) {
      const r = await withIdempotency(ctx, scope({ key: 'shared', ...v }), exec);
      expect(r.replayed).toBe(false);
    }
    expect(runs).toBe(variants.length);
  });

  it('lets one of two concurrent first requests run; the other gets 409 or the replay', async () => {
    const { ctx, scope } = setup();
    const s = scope({ key: 'race' });
    let runs = 0;
    const exec = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      return { status: 201, body: { ok: true } };
    };
    const results = await Promise.allSettled([
      withIdempotency(ctx, s, exec),
      withIdempotency(ctx, s, exec),
    ]);
    expect(runs).toBe(1);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won.length + lost.length).toBe(2);
    expect(won.length).toBeGreaterThanOrEqual(1);
    for (const l of lost)
      expect((l as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
        code: 'IDEMPOTENCY_IN_PROGRESS',
      });
  });

  it('releases the key when the first call throws', async () => {
    const { ctx, scope } = setup();
    const s = scope({ key: 'fail' });
    await expect(
      withIdempotency(ctx, s, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const retry = await withIdempotency(ctx, s, async () => ({ status: 201, body: 'ok' }));
    expect(retry.replayed).toBe(false);
  });

  it('reclaims a claim whose first call died', async () => {
    const { clock, ctx, scope } = setup();
    const s = scope({ key: 'dead' });
    let release: (() => void) | undefined;
    const stuck = withIdempotency(
      ctx,
      s,
      () => new Promise((resolve) => (release = () => resolve({ status: 200, body: 'late' }))),
    );
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      withIdempotency(ctx, s, async () => ({ status: 200, body: 'x' })),
    ).rejects.toMatchObject({
      status: 409,
    });
    clock.advance(16 * 60_000);
    const r = await withIdempotency(ctx, s, async () => ({ status: 200, body: 'second' }));
    expect(r).toMatchObject({ body: 'second', replayed: false });
    release?.();
    await stuck;
  });

  it('sweeps rows after the 24 hour TTL', async () => {
    const { clock, ctx, scope } = setup();
    await withIdempotency(ctx, scope({ key: 'ttl' }), async () => ({ status: 200, body: 1 }));
    const count = () =>
      first<{ n: number }>(e.DB, "SELECT COUNT(*) AS n FROM idempotent_requests WHERE key = 'ttl'");
    await sweepIdempotency(ctx);
    expect((await count())?.n).toBe(1);
    clock.advance(IDEMPOTENCY_TTL_MS + 1);
    await sweepIdempotency(ctx);
    expect((await count())?.n).toBe(0);
  });

  it('sweeps more than one batch, and only expired rows', async () => {
    const { clock, ctx } = setup();
    const now = clock.now();
    const rows = Array.from({ length: 2300 }, (_, i) =>
      e.DB.prepare(
        `INSERT INTO idempotent_requests (org_id, mode, principal, operation, key, request_hash, created_at, expires_at)
         VALUES ('o', 'live', 'p', 'op', ?, 'h', ?, ?)`,
      ).bind(`bulk-${i}`, now, i < 2200 ? now - 1 : now + 1000),
    );
    await e.DB.batch(rows);
    await sweepIdempotency(ctx);
    const left = await first<{ n: number }>(
      e.DB,
      "SELECT COUNT(*) AS n FROM idempotent_requests WHERE key LIKE 'bulk-%'",
    );
    expect(left?.n).toBe(100);
  });
});
