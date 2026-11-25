import { describe, expect, it } from 'vitest';
import { type Deps, pocketRequest } from '../../workers/polaris-binding/src/pocket-http.ts';
import { API_KEY, baseEnv, captureLogs, ctx, NOW, resetLedger, setup } from './harness.ts';

const env = baseEnv();
const deps = (fetch: typeof globalThis.fetch): Deps => ({ fetch, now: () => NOW });

describe('pocketRequest', () => {
  it('pins the origin, sends the key in X-API-KEY, never follows redirects, and times out', async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const res = await pocketRequest(
      env,
      deps(async (url, init) => {
        seen = { url: String(url), init };
        return new Response('{"ok":true}', { headers: { 'x-request-id': 'r-1' } });
      }),
      'GET',
      '/api/user-groups/g-dev',
    );
    expect(res).toEqual({ status: 200, body: { ok: true }, requestId: 'r-1' });
    expect(seen?.url).toBe('https://id.test/api/user-groups/g-dev');
    expect(seen?.init?.redirect).toBe('manual');
    expect(new Headers(seen?.init?.headers).get('x-api-key')).toBe(API_KEY);
    expect(new Headers(seen?.init?.headers).has('authorization')).toBe(false);
    expect(seen?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    '//evil.test/api/x',
    '/other/path',
    'https://evil.test/api/x',
    '/api/../x@evil.test',
    '/api/users/me/user-groups',
  ])('refuses %s', async (path) => {
    const calls: string[] = [];
    await expect(
      pocketRequest(
        env,
        deps(async (url) => {
          calls.push(String(url));
          return new Response('{}');
        }),
        'GET',
        path,
      ),
    ).rejects.toThrow(/^IDP_MISCONFIGURED/);
    expect(calls).toEqual([]);
  });

  it('treats a redirect as an upstream error and does not follow it', async () => {
    const s = setup();
    s.pocket.fetch = async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.test/x' } });
    const api = (await import('../../workers/polaris-binding/src/api.ts')).createApi(env, {
      fetch: s.pocket.fetch,
      now: () => NOW,
    });
    await resetLedger();
    await expect(api.health()).rejects.toThrow(/^IDP_UPSTREAM: Polaris ID answered 302\./);
  });

  it('caps the body at 256 KB', async () => {
    const big = 'x'.repeat(256 * 1024 + 1);
    await expect(
      pocketRequest(
        env,
        deps(async () => new Response(`"${big}"`)),
        'GET',
        '/api/user-groups/x',
      ),
    ).rejects.toThrow(/^IDP_UPSTREAM/);
    const ok = 'x'.repeat(200 * 1024);
    await expect(
      pocketRequest(
        env,
        deps(async () => new Response(`"${ok}"`)),
        'GET',
        '/api/user-groups/x',
      ),
    ).resolves.toMatchObject({ status: 200 });
  });

  it.each([
    ['POST', '/api/users'],
    ['DELETE', '/api/users/u1'],
    ['PUT', '/api/users/me'],
    ['POST', '/api/users/u1/one-time-access-token'],
    ['PUT', '/api/custom-claims/user/u1'],
    ['PUT', '/api/oidc/clients/c1'],
    ['POST', '/api/oidc/clients'],
    ['POST', '/api/user-groups'],
    ['PUT', '/api/user-groups/g1'],
    ['DELETE', '/api/user-groups/g1'],
    ['PUT', '/api/user-groups/g1/users'],
    ['PUT', '/api/application-configuration'],
    ['POST', '/api/api-keys'],
    ['DELETE', '/api/api-keys/k1'],
    ['GET', '/api/users/u1/profile-picture.png'],
  ])('refuses %s %s: not a route the binding may call', async (method, path) => {
    const calls: string[] = [];
    await expect(
      pocketRequest(
        env,
        deps(async (url) => {
          calls.push(String(url));
          return new Response('{}');
        }),
        method as 'GET',
        path,
      ),
    ).rejects.toThrow(/^IDP_MISCONFIGURED/);
    expect(calls).toEqual([]);
  });

  it('maps a network failure to IDP_UPSTREAM without its text', async () => {
    const logs = await captureLogs(() =>
      pocketRequest(
        env,
        deps(async () => {
          throw new Error(`connect failed with ${API_KEY}`);
        }),
        'GET',
        '/api/user-groups/x',
      ),
    );
    expect(String(logs.error)).toBe('IdpError: IDP_UPSTREAM: Polaris ID was unreachable.');
  });
});

describe('error mapping', () => {
  it.each([
    [401, 'IDP_AUTH'],
    [403, 'IDP_AUTH'],
    [404, 'IDP_NOT_FOUND'],
    [409, 'IDP_CONFLICT'],
    [422, 'IDP_CONFLICT'],
    [429, 'IDP_UPSTREAM'],
    [500, 'IDP_UPSTREAM'],
    [302, 'IDP_UPSTREAM'],
  ])('answers %i as %s', async (status, code) => {
    await resetLedger();
    const s = setup();
    s.pocket.s.failWith = { match: /user-groups\//, status };
    const run = s.api.apply('u1', { add: ['developer'] }, ctx());
    const expected = status === 404 ? 'IDP_UNSAFE_CONFIG' : code;
    await expect(run).rejects.toThrow(new RegExp(`^${expected}`));
  });
});
