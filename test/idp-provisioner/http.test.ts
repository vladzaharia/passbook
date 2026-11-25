import { describe, expect, it } from 'vitest';
import { type Deps, pocketRequest } from '../../workers/idp-provisioner/src/pocket-http.ts';
import { API_KEY, baseEnv, captureLogs, NOW, resetLedger, setup } from './harness.ts';

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

  it.each(['//evil.test/api/x', '/other/path', 'https://evil.test/api/x', '/api/../x@evil.test'])(
    'refuses %s',
    async (path) => {
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
    },
  );

  it('treats a redirect as an upstream error and does not follow it', async () => {
    const s = setup();
    s.pocket.fetch = async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.test/x' } });
    const api = (await import('../../workers/idp-provisioner/src/api.ts')).createApi(env, {
      fetch: s.pocket.fetch,
      now: () => NOW,
    });
    await resetLedger();
    await expect(api.health()).rejects.toThrow(/^IDP_UPSTREAM: Pocket ID answered 302\./);
  });

  it('caps the body at 256 KB', async () => {
    const big = 'x'.repeat(256 * 1024 + 1);
    await expect(
      pocketRequest(
        env,
        deps(async () => new Response(`"${big}"`)),
        'GET',
        '/api/x',
      ),
    ).rejects.toThrow(/^IDP_UPSTREAM/);
    const ok = 'x'.repeat(200 * 1024);
    await expect(
      pocketRequest(
        env,
        deps(async () => new Response(`"${ok}"`)),
        'GET',
        '/api/x',
      ),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('maps a network failure to IDP_UPSTREAM without its text', async () => {
    const logs = await captureLogs(() =>
      pocketRequest(
        env,
        deps(async () => {
          throw new Error(`connect failed with ${API_KEY}`);
        }),
        'GET',
        '/api/x',
      ),
    );
    expect(String(logs.error)).toBe('Error: IDP_UPSTREAM: Pocket ID was unreachable.');
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
    s.pocket.s.failWith = { match: /user-groups/, status };
    const run = s.api.addDeveloper('u1', 'r1');
    const expected = status === 404 ? 'IDP_UNSAFE_CONFIG' : code;
    await expect(run).rejects.toThrow(new RegExp(`^${expected}`));
  });
});
