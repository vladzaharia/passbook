import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  fakeAuth,
  fakeRateLimiter,
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
} from '../../../test/helpers/index.ts';
import { createApp } from '../app.ts';
import { createApiKeyStore } from '../modules/api-keys/service.ts';
import type { AppBindings } from './context.ts';
import { handleError } from './error-handler.ts';
import { API_ORG_LIMIT, apiKeyRateHeaders, apiRateTier, enforceApiKeyRate } from './rate-limit.ts';

const keyApp = (env: Awaited<ReturnType<typeof makeEnv>>) => {
  const app = new Hono<AppBindings>();
  app.onError((e, c) => handleError(e, c) as Response);
  app.use('*', apiKeyRateHeaders);
  app.get('/x', async (c) => {
    const raw = c.req.header('authorization')?.slice(7) ?? '';
    const auth = await createApiKeyStore(env).resolve(raw);
    if (auth) c.set('auth', auth);
    return c.json({ ok: true });
  });
  return app;
};

describe('tiers', () => {
  it('reads the stored tier, then the env default, then standard', async () => {
    const env = await makeEnv({ API_RATE_TIER_DEFAULT: 'high' } as never);
    expect(apiRateTier('bulk', env)).toBe('bulk');
    expect(apiRateTier(null, env)).toBe('high');
    expect(apiRateTier('nope', env)).toBe('high');
    expect(apiRateTier(undefined, await makeEnv())).toBe('standard');
  });

  it('sends the limit of each tier on every key response', async () => {
    for (const [tier, limit] of [
      ['standard', '600'],
      ['high', '3000'],
      ['bulk', '12000'],
    ] as const) {
      const env = await makeEnv({ API_RATE_TIER_DEFAULT: tier } as never);
      const org = await makeOrg(fixtures(env));
      const key = await makeApiKey(fixtures(env), { orgId: org.id });
      const res = await keyApp(env).request('/x', { headers: key.headers }, env);
      expect(res.status).toBe(200);
      expect(res.headers.get('ratelimit-limit')).toBe(limit);
      expect(res.headers.get('ratelimit-policy')).toBe(`${limit};w=60`);
      expect(res.headers.get('ratelimit-reset')).toMatch(/^\d+$/);
    }
  });

  it('charges the tier binding, not the standard one', async () => {
    const high = fakeRateLimiter({ limit: 100 });
    const std = fakeRateLimiter({ limit: 100 });
    const env = await makeEnv({ RL_API_KEY: std, RL_API_KEY_HIGH: high });
    await enforceApiKeyRate(env, { keyId: 'k1', orgId: null }, 'high');
    expect(high.counts.get('key:k1')).toBe(1);
    expect(std.counts.size).toBe(0);
  });
});

describe('org cap', () => {
  it('stops a second key once the org budget is spent, and spares other orgs', async () => {
    const org = fakeRateLimiter({ limit: 3 });
    const env = await makeEnv({ RL_API_KEY: fakeRateLimiter({ limit: 100 }), RL_API_ORG: org });
    const f = fixtures(env);
    const o = await makeOrg(f);
    const other = await makeOrg(f);
    const a = await makeApiKey(f, { orgId: o.id });
    const b = await makeApiKey(f, { orgId: o.id });
    const c = await makeApiKey(f, { orgId: other.id });
    const app = keyApp(env);
    const status = async (k: { headers: Record<string, string> }) =>
      (await app.request('/x', { headers: k.headers }, env)).status;
    expect([await status(a), await status(b), await status(a)]).toEqual([200, 200, 200]);
    expect(await status(b)).toBe(429);
    expect(await status(c)).toBe(200);
  });

  it('answers 429 problem+json with the wait and the org policy', async () => {
    const env = await makeEnv({ RL_API_ORG: fakeRateLimiter({ limit: 0 }) });
    const f = fixtures(env);
    const k = await makeApiKey(f, { orgId: (await makeOrg(f)).id });
    const res = await keyApp(env).request('/x', { headers: k.headers }, env);
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    expect(res.headers.get('ratelimit-remaining')).toBe('0');
    expect(res.headers.get('ratelimit-policy')).toBe(`${API_ORG_LIMIT};w=60`);
    expect(await res.json()).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  });

  it('does not spend the org budget when the key is over its own', async () => {
    const org = fakeRateLimiter({ limit: 100 });
    const env = await makeEnv({ RL_API_KEY: fakeRateLimiter({ limit: 0 }), RL_API_ORG: org });
    await expect(enforceApiKeyRate(env, { keyId: 'k', orgId: 'o' }, null)).rejects.toMatchObject({
      status: 429,
    });
    expect(org.counts.size).toBe(0);
  });

  it('exempts platform keys from the org cap', async () => {
    const org = fakeRateLimiter({ limit: 0 });
    const env = await makeEnv({ RL_API_ORG: org });
    await enforceApiKeyRate(env, { keyId: 'p', orgId: null }, null);
    expect(org.counts.size).toBe(0);
  });
});

describe('session traffic', () => {
  it('is not charged and gets no rate headers', async () => {
    const std = fakeRateLimiter({ limit: 0 });
    const org = fakeRateLimiter({ limit: 0 });
    const env = await makeEnv({ RL_API_KEY: std, RL_API_ORG: org });
    const fake = fakeAuth();
    const res = await createApp({ stores: fake.stores }).request(
      '/api/v1/passes',
      { headers: fake.admin() },
      env,
    );
    expect(res.status).not.toBe(429);
    expect(res.headers.get('ratelimit-policy')).toBeNull();
    expect(std.counts.size + org.counts.size).toBe(0);
  });
});
