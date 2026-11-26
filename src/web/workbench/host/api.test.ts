import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.ts';
import { createToolApi } from './api.ts';
import { dropToken, forgetTokens, RENEW_MS, renewAt, TOKEN_PATH, workbenchToken } from './token.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  forgetTokens();
  vi.unstubAllGlobals();
});

describe('the Workbench client (L13)', () => {
  it('sends a bearer, omits credentials and never a mode header', async () => {
    const fetch = vi.fn(async () => json({ ok: true }));
    const api = createToolApi({
      orgId: 'org_1',
      token: async () => 'pbtry_abc',
      drop: () => undefined,
      fetch,
    });
    await api.post(
      '/api/v1/passes',
      z.object({ ok: z.boolean() }),
      { a: 1 },
      {
        headers: { 'X-PassBook-Mode': 'live', 'Idempotency-Key': 'k1' },
        query: { dryRun: true, empty: '' },
      },
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/passes?dryRun=true');
    expect(init.credentials).toBe('omit');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer pbtry_abc');
    expect(headers['idempotency-key']).toBe('k1');
    expect(Object.keys(headers).some((h) => /mode/i.test(h))).toBe(false);
    expect(headers['x-csrf-token']).toBeUndefined();
  });

  it('mints once more after a 401, then lets the error stand', async () => {
    let n = 0;
    const tokens = ['t1', 't2', 't3'];
    const drop = vi.fn();
    const fetch = vi.fn(async () =>
      json({ type: 'about:blank', status: 401, code: 'unauthenticated', detail: 'Sign in.' }, 401),
    );
    const api = createToolApi({
      orgId: 'org_1',
      token: async () => tokens[n++] ?? 'tx',
      drop,
      fetch,
    });
    const failed = await api.get('/api/v1/request-logs', z.unknown()).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ApiError);
    expect((failed as ApiError).status).toBe(401);
    expect(drop).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const auth = (i: number) =>
      (
        (fetch.mock.calls[i] as unknown as [string, RequestInit])[1].headers as Record<
          string,
          string
        >
      ).authorization;
    expect([auth(0), auth(1)]).toEqual(['Bearer t1', 'Bearer t2']);
  });

  it('says the session is gone when the mint itself is refused', async () => {
    const onSessionGone = vi.fn();
    const api = createToolApi({
      orgId: 'org_1',
      token: async () => {
        throw new ApiError({ status: 401, code: 'unauthenticated' });
      },
      drop: () => undefined,
      onSessionGone,
      fetch: vi.fn(),
    });
    await expect(api.get('/api/v1/passes', z.unknown())).rejects.toBeInstanceOf(ApiError);
    expect(onSessionGone).toHaveBeenCalledTimes(1);
  });
});

describe('the Workbench token', () => {
  it('mints per org from the session with CSRF, holds it in memory and renews at 12 minutes', async () => {
    const now = Date.now();
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { orgId } = JSON.parse(String(init.body)) as { orgId: string };
      return json({
        token: `pbtry_${orgId}`,
        orgId,
        mode: 'test',
        expiresAt: now + 15 * 60_000,
        subject: 'member',
      });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await workbenchToken('org_1', 'csrf-1')).toBe('pbtry_org_1');
    expect(await workbenchToken('org_1', 'csrf-1')).toBe('pbtry_org_1');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TOKEN_PATH);
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-1');
    expect(init.credentials).toBe('same-origin');
    dropToken('org_1');
    await workbenchToken('org_1', 'csrf-1');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(renewAt(now, now + 15 * 60_000)).toBe(now + RENEW_MS);
    expect(renewAt(now, now + 5 * 60_000)).toBe(now + 2 * 60_000);
  });

  it('never uses a token minted for another org or not in Test', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ token: 't', orgId: 'org_2', mode: 'test', expiresAt: 0, subject: 'member' }),
      ),
    );
    await expect(workbenchToken('org_1', 'c')).rejects.toThrow(/another organization/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ token: 't', orgId: 'org_1', mode: 'live', expiresAt: 0, subject: 'member' }),
      ),
    );
    await expect(workbenchToken('org_1', 'c')).rejects.toBeInstanceOf(ApiError);
  });
});
