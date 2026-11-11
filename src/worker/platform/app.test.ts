import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/fake-auth.ts';
import { createApp } from '../app.ts';
import type { AppEnv } from './env.ts';
import { PERMISSIONS_POLICY } from './security-headers.ts';

const ORIGIN = 'https://wallet.test';
const auth = fakeAuth(ORIGIN);
const app = createApp({ stores: auth.stores });
const call = (path: string, init: RequestInit = {}) =>
  app.request(`${ORIGIN}${path}`, init, env as AppEnv);

describe('app shell', () => {
  it('serves health with security headers', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).not.toMatch(/(?:script|style)-src [^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('strict-transport-security')).toContain('includeSubDomains');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toBe(PERMISSIONS_POLICY);
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('uses no-referrer and no-store on auth and api paths', async () => {
    const res = await call('/auth/magic');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await call('/p/abcdefghijklmnopqrstuv')).headers.get('referrer-policy')).toBe(
      'no-referrer',
    );
  });

  it('caps api and hook bodies at 256 KB', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(300 * 1024) });
    const post = (path: string) =>
      call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
    expect((await post('/api/v1/holders/assign')).status).toBe(413);
    expect((await post('/hooks/anything/x')).status).toBe(413);
  });

  it('answers a missing asset with an uncached 404', async () => {
    const ASSETS = {
      fetch: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    };
    const res = await app.request(`${ORIGIN}/assets/missing-chunk.js`, {}, {
      ...env,
      ASSETS,
    } as unknown as AppEnv);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  // Other unknown paths are the SPA's pages (host-policy.test.ts).
  it('returns problem+json for unknown Worker routes', async () => {
    const res = await call('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('publishes OpenAPI for every mounted stub', async () => {
    const res = await call('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    for (const path of [
      '/api/v1/passes',
      '/api/v1/passes/{id}',
      '/api/v1/templates/uploads',
      '/api/v1/me/passes',
      '/wallet/v1/log',
      '/p/{token}',
      '/p/{token}/wallet/{provider}',
      '/p/wallet/samsung/{offer}',
      '/wallet/v1/google/{accountId}',
      '/wallet/v1/samsung/cards/{cardId}/{refId}',
      '/api/v1/wallet-providers/accounts',
      '/api/v1/wallet-providers/accounts/verify',
      '/api/v1/wallet-providers/passes/{id}',
      '/api/v1/holders/assign',
    ]) {
      expect(doc.paths, path).toHaveProperty([path]);
    }
  });
});

describe('wallet route isolation', () => {
  it('uses native callback limits without passing through Apple middleware', async () => {
    const keys: string[] = [];
    const limit = async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: true };
    };
    const limits = { limit };
    const appEnv = { ...env, RL_APPLE_IP: limits, RL_APPLE: limits } as unknown as AppEnv;
    const headers = { 'cf-connecting-ip': '203.0.113.25', 'content-type': 'application/json' };

    const google = await app.request(
      `${ORIGIN}/wallet/v1/google/account`,
      {
        method: 'POST',
        headers,
        body: 'x'.repeat(17 * 1024),
      },
      appEnv,
    );
    expect(google.status).toBe(413);
    expect(keys).toEqual(['RL_APPLE_IP:google:203.0.113.25']);

    keys.length = 0;
    const samsung = await app.request(
      `${ORIGIN}/wallet/v1/samsung/cards/card/short`,
      {
        headers,
      },
      appEnv,
    );
    expect(samsung.status).toBe(422);
    expect(keys).toEqual(['RL_APPLE_IP:samsung:203.0.113.25']);

    keys.length = 0;
    const apple = await app.request(
      `${ORIGIN}/wallet/v1/log`,
      {
        method: 'POST',
        headers,
        body: '{}',
      },
      appEnv,
    );
    expect(apple.status).toBe(422);
    expect(keys).toEqual(['RL_APPLE_IP:203.0.113.25', 'RL_APPLE:203.0.113.25']);
  });
});

describe('auth ports', () => {
  it('requires a session', async () => {
    const res = await call('/api/v1/users');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('requires authentication for wallet account and pass status routes', async () => {
    for (const path of [
      '/api/v1/wallet-providers/accounts?orgId=o&mode=live&provider=google',
      '/api/v1/wallet-providers/passes/p1',
    ]) {
      const res = await call(path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('refuses non-admin sessions on admin routes', async () => {
    const res = await call('/api/v1/users', { headers: auth.user() });
    expect(res.status).toBe(403);
  });

  it('reports an authenticated refusal once, and nothing for anonymous or unknown callers', async () => {
    auth.denied.length = 0;
    expect((await call('/api/v1/users', { headers: auth.user('u-9') })).status).toBe(403);
    expect(auth.denied).toEqual([
      expect.objectContaining({
        code: 'FORBIDDEN',
        actorType: 'user',
        actorId: 'u-9',
        route: '/api/v1/users',
      }),
    ]);
    await call('/api/v1/users');
    await call('/api/v1/passes', { headers: { authorization: 'Bearer wlt_unknown_key' } });
    expect(auth.denied).toHaveLength(1);
  });

  it('lets an admin reach admin routes', async () => {
    const res = await call('/api/v1/users', { headers: auth.admin() });
    expect(res.status).toBe(200);
  });

  it('lets a user session reach /me', async () => {
    expect((await call('/api/v1/me/emails', { headers: auth.user() })).status).toBe(200);
  });

  it('validates input before the handler (422 problem+json)', async () => {
    const res = await call('/api/v1/orgs', {
      method: 'POST',
      headers: { ...auth.admin(), 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'Bad Slug' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; issues: { path: string }[] };
    expect(body.code).toBe('VALIDATION');
    expect(body.issues.map((i) => i.path)).toContain('slug');
  });
});

describe('csrf', () => {
  const post = (headers: Record<string, string>) =>
    call('/api/v1/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ slug: 'Bad Slug' }),
    });

  it('accepts same-origin requests with the session token', async () => {
    expect((await post(auth.admin())).status).toBe(422);
  });

  it('rejects a missing or wrong token', async () => {
    const { 'x-csrf-token': _t, ...noToken } = auth.admin();
    expect(await (await post(noToken)).json()).toMatchObject({ code: 'CSRF_TOKEN' });
    expect(await (await post({ ...auth.admin(), 'x-csrf-token': 'wrong' })).json()).toMatchObject({
      code: 'CSRF_TOKEN',
    });
  });

  it('rejects cross-site requests', async () => {
    const res = await post({ ...auth.admin(), 'sec-fetch-site': 'cross-site' });
    expect(await res.json()).toMatchObject({ code: 'CSRF_ORIGIN' });
  });

  it('falls back to the Origin header when Sec-Fetch-Site is absent', async () => {
    const headers = auth.admin();
    const { 'sec-fetch-site': _s, ...rest } = headers;
    expect((await post({ ...rest, origin: ORIGIN })).status).toBe(422);
    expect(await (await post({ ...rest, origin: 'https://evil.test' })).json()).toMatchObject({
      code: 'CSRF_ORIGIN',
    });
    expect(
      await (
        await post(
          rest.cookie ? { cookie: rest.cookie, 'x-csrf-token': rest['x-csrf-token'] ?? '' } : {},
        )
      ).json(),
    ).toMatchObject({ code: 'CSRF_ORIGIN' });
  });

  it('exempts API keys (cookie-free)', async () => {
    const res = await call('/api/v1/passes', {
      method: 'POST',
      headers: { ...auth.apiKey({ scopes: ['passes:write'] }), 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'o', templateId: 't', input: {} }),
    });
    expect(res.status).toBe(422);
  });

  it('protects the unauthenticated magic-link request by origin only', async () => {
    const body = JSON.stringify({ email: 'a@example.com', turnstileToken: 't' });
    const bad = await call('/auth/magic/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body,
    });
    expect(await bad.json()).toMatchObject({ code: 'CSRF_ORIGIN' });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'challenges.cloudflare.com') throw new Error(`Unexpected fetch ${url}`);
      return Response.json({ success: true });
    }) as typeof fetch;
    try {
      const ok = await call('/auth/magic/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body,
      });
      expect(ok.status).toBe(202);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('api keys', () => {
  it('enforces scopes by method', async () => {
    const readOnly = auth.apiKey({ scopes: ['passes:read'] });
    expect((await call('/api/v1/passes/p1', { headers: readOnly })).status).toBe(404);
    const write = await call('/api/v1/passes/p1', {
      method: 'PATCH',
      headers: { ...readOnly, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ code: 'MISSING_SCOPE' });
  });

  it('rejects unknown keys and keeps keys out of admin-only routes', async () => {
    expect(
      (await call('/api/v1/passes', { headers: { authorization: 'Bearer wlt_unknown_key' } }))
        .status,
    ).toBe(401);
    expect((await call('/api/v1/users', { headers: auth.apiKey() })).status).toBe(401);
  });

  it('allows template reads with templates:read and refuses template writes', async () => {
    expect(
      (await call('/api/v1/templates', { headers: auth.apiKey({ scopes: ['templates:read'] }) }))
        .status,
    ).toBe(200);
    const res = await call('/api/v1/templates/t1', {
      method: 'DELETE',
      headers: auth.apiKey({ scopes: ['templates:read'] }),
    });
    expect(res.status).toBe(401);
  });
});
