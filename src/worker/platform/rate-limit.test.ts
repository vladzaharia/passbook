import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeRateLimiter, makeEnv } from '../../../test/helpers/index.ts';
import { AppError, RateLimitedError } from './errors.ts';
import { enforceRateLimit, resetRateLimitWarnings } from './rate-limit.ts';

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
