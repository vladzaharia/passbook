import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeRateLimiter, makeEnv } from '../../../test/helpers/index.ts';
import type { AppBindings } from './context.ts';
import { AppError, RateLimitedError } from './errors.ts';
import { enforceRateLimit, rateLimit, resetRateLimitWarnings } from './rate-limit.ts';

afterEach(() => {
  vi.restoreAllMocks();
  resetRateLimitWarnings();
});

describe('enforceRateLimit', () => {
  it('fails closed with a 503 and logs once when the binding is missing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = await makeEnv({ RL_LOGIN: undefined } as never);
    const err = await enforceRateLimit(env, 'RL_LOGIN', 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE', status: 503 });
    await enforceRateLimit(env, 'RL_LOGIN', 'k').catch(() => {});
    const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('ratelimit.'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      event: 'ratelimit.binding_missing',
      code: 'RATE_LIMIT_UNAVAILABLE',
      name: 'RL_LOGIN',
    });
  });

  it('passes under the limit and throws RateLimitedError past it', async () => {
    const env = await makeEnv({ RL_LOGIN: fakeRateLimiter({ limit: 2 }) });
    await enforceRateLimit(env, 'RL_LOGIN', 'a');
    await enforceRateLimit(env, 'RL_LOGIN', 'a');
    await expect(enforceRateLimit(env, 'RL_LOGIN', 'a')).rejects.toBeInstanceOf(RateLimitedError);
    await enforceRateLimit(env, 'RL_LOGIN', 'b');
  });
});

describe('rateLimit default key', () => {
  async function statuses(ips: string[]) {
    const env = await makeEnv({ RL_LOGIN: fakeRateLimiter({ limit: 1 }) });
    const app = new Hono<AppBindings>();
    app.onError((e) => new Response(null, { status: e instanceof RateLimitedError ? 429 : 500 }));
    app.use('*', rateLimit('RL_LOGIN'));
    app.get('/', (c) => c.text('ok'));
    const out: number[] = [];
    for (const ip of ips) {
      out.push((await app.request('/', { headers: { 'cf-connecting-ip': ip } }, env)).status);
    }
    return out;
  }

  it('shares one bucket across an IPv6 /64', async () => {
    expect(await statuses(['2001:db8:1:2::1', '2001:db8:1:2:abcd::9', '2001:db8:1:3::1'])).toEqual([
      200, 429, 200,
    ]);
  });

  it('shares one bucket across an IPv4 /24 and keeps other networks apart', async () => {
    expect(await statuses(['203.0.113.5', '203.0.113.200', '203.0.114.5'])).toEqual([
      200, 429, 200,
    ]);
  });

  it('puts requests without a usable address in one bucket', async () => {
    expect(await statuses(['unknown', 'not-an-ip'])).toEqual([200, 429]);
  });
});
