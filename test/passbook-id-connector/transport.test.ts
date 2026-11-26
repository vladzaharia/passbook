import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../workers/passbook-id-connector/src/api.ts';
import { depsFor } from '../../workers/passbook-id-connector/src/index.ts';
import { pocketRequest } from '../../workers/passbook-id-connector/src/pocket-http.ts';
import { API_KEY, baseEnv, captureLogs, ORIGIN, resetLedger, setup } from './harness.ts';

const fetcher = (handler: (req: Request) => Promise<Response>) =>
  ({ fetch: handler }) as unknown as Fetcher;

afterEach(() => vi.unstubAllGlobals());

describe('POLARIS service binding transport', () => {
  it('sends the request through the binding with the origin URL and the key header', async () => {
    const seen: Request[] = [];
    const global = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', global);
    const env = {
      ...baseEnv(),
      POLARIS: fetcher(async (req) => {
        seen.push(req);
        return new Response('{"ok":true}');
      }),
    };
    const res = await pocketRequest(env, depsFor(env), 'GET', '/api/user-groups/g-dev');
    expect(res.body).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${ORIGIN}/api/user-groups/g-dev`);
    expect(seen[0]?.headers.get('x-api-key')).toBe(API_KEY);
    expect(seen[0]?.redirect).toBe('manual');
    expect(global).not.toHaveBeenCalled();
  });

  it('uses the global fetch without a binding', async () => {
    const global = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'),
    );
    vi.stubGlobal('fetch', global);
    const env = baseEnv();
    await pocketRequest(env, depsFor(env), 'GET', '/api/user-groups/g-dev');
    expect(global).toHaveBeenCalledTimes(1);
    expect(String(global.mock.calls[0]?.[0])).toBe(`${ORIGIN}/api/user-groups/g-dev`);
  });

  it('fails closed on a binding error: stable code, logged, no HTTPS fallback', async () => {
    const global = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', global);
    const env = {
      ...baseEnv(),
      POLARIS: fetcher(async () => {
        throw new Error('no such service');
      }),
    };
    const { lines } = await captureLogs(() =>
      expect(pocketRequest(env, depsFor(env), 'GET', '/api/user-groups/g-dev')).rejects.toThrow(
        /^IDP_UPSTREAM: Polaris ID was unreachable\./,
      ),
    );
    expect(lines.join('\n')).toContain('binding.upstream_unreachable');
    expect(lines.join('\n')).not.toContain(API_KEY);
    expect(global).not.toHaveBeenCalled();
  });

  it('reports the transport in health', async () => {
    const s = setup();
    await resetLedger();
    expect((await s.api.health()).transport).toBe('https');
    await resetLedger();
    const bound = {
      ...baseEnv(),
      POLARIS: fetcher((req) =>
        s.pocket.fetch(req.url, { method: req.method, headers: req.headers }),
      ),
    };
    const api = createApi(bound, depsFor(bound));
    expect((await api.health()).transport).toBe('binding');
  });
});
