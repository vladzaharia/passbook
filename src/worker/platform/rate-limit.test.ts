import { type Context, Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeRateLimiter, makeEnv } from '../../../test/helpers/index.ts';
import type { AppBindings } from './context.ts';
import { AppError, RateLimitedError } from './errors.ts';
import {
  clientRatePrefix,
  enforceRateLimit,
  rateLimit,
  resetRateLimitWarnings,
} from './rate-limit.ts';

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

describe('rate limit keys', () => {
  async function statuses(ips: string[], keyOf?: (c: Context) => string) {
    const env = await makeEnv({ RL_LOGIN: fakeRateLimiter({ limit: 1 }) });
    const app = new Hono<AppBindings>();
    app.onError((e) => new Response(null, { status: e instanceof RateLimitedError ? 429 : 500 }));
    app.use('*', rateLimit('RL_LOGIN', keyOf));
    app.get('/', (c) => c.text('ok'));
    const out: number[] = [];
    for (const ip of ips) {
      out.push((await app.request('/', { headers: { 'cf-connecting-ip': ip } }, env)).status);
    }
    return out;
  }

  describe('default: the IPv4 address or IPv6 /64', () => {
    it('shares one bucket across an IPv6 /64', async () => {
      expect(
        await statuses(['2001:db8:1:2::1', '2001:db8:1:2:abcd::9', '2001:db8:1:3::1']),
      ).toEqual([200, 429, 200]);
    });

    it('keeps IPv4 addresses of one /24 apart', async () => {
      expect(await statuses(['203.0.113.5', '203.0.113.200', '203.0.113.5'])).toEqual([
        200, 200, 429,
      ]);
      expect(await statuses(['203.0.113.5', '::ffff:203.0.113.5'])).toEqual([200, 429]);
    });

    it('puts requests without a usable address in one bucket', async () => {
      expect(await statuses(['unknown', 'not-an-ip'])).toEqual([200, 429]);
    });
  });

  describe('auth and guessing limits: clientRatePrefix', () => {
    it('shares one bucket across an IPv4 /24 and an IPv6 /64', async () => {
      expect(
        await statuses(['203.0.113.5', '203.0.113.200', '203.0.114.5'], clientRatePrefix),
      ).toEqual([200, 429, 200]);
      expect(
        await statuses(
          ['2001:db8:1:2::1', '2001:db8:1:2:abcd::9', '2001:db8:1:3::1'],
          clientRatePrefix,
        ),
      ).toEqual([200, 429, 200]);
    });
  });
});

describe('429 headers', () => {
  it('keeps Retry-After 60 and no policy for other limiters', async () => {
    const env = await makeEnv({ RL_LOGIN: fakeRateLimiter({ limit: 0 }) });
    const err = await enforceRateLimit(env, 'RL_LOGIN', 'a').catch((e: unknown) => e);
    expect((err as RateLimitedError).headers).toEqual({ 'retry-after': '60' });
  });

  it('sends the key policy only for a key budget, not for other RL_API_KEY users', async () => {
    const env = await makeEnv({ RL_API_KEY: fakeRateLimiter({ limit: 0 }) });
    const key = await enforceRateLimit(env, 'RL_API_KEY', 'key:abc').catch((e: unknown) => e);
    const headers = (key as RateLimitedError).headers as Record<string, string>;
    expect(Number(headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(headers['ratelimit-policy']).toBe('600;w=60');
    const other = await enforceRateLimit(env, 'RL_API_KEY', 'test-config:u1').catch(
      (e: unknown) => e,
    );
    expect((other as RateLimitedError).headers).toEqual({ 'retry-after': '60' });
  });
});
