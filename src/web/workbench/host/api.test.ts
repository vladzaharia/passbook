import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.ts';
import { createBearerFetch, createToolApi } from './api.ts';
import {
  dropToken,
  dueIn,
  forgetTokens,
  onTokenMinted,
  RENEW_MS,
  renewAt,
  serverTtl,
  TOKEN_PATH,
  workbenchToken,
} from './token.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  forgetTokens();
  vi.unstubAllGlobals();
});

describe('the Workbench client (L13)', () => {
  it('sends a bearer, binds the cookie and never sends a mode header', async () => {
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
    expect(init.credentials).toBe('same-origin');
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
    expect(renewAt(now, 15 * 60_000)).toBe(now + RENEW_MS);
    expect(renewAt(now, 5 * 60_000)).toBe(now + 2 * 60_000);
    // Never sooner than a minute, whatever the server says.
    expect(renewAt(now, 2 * 60_000)).toBe(now + 60_000);
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

let minted = 0;
const mintResponse = (orgId: string, serverNow: number, ttl = 15 * 60_000) =>
  new Response(
    JSON.stringify({
      token: `pbtry_${orgId}_${minted++}`,
      orgId,
      mode: 'test',
      expiresAt: serverNow + ttl,
      subject: 'member',
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', date: new Date(serverNow).toUTCString() },
    },
  );

describe('renewal on the server clock (R4 M3)', () => {
  it('counts the lifetime from the server Date, so a fast or slow device clock changes nothing', async () => {
    vi.useFakeTimers();
    try {
      const server = Date.UTC(2026, 10, 26, 12, 0, 0);
      for (const offset of [20 * 60_000, -20 * 60_000]) {
        forgetTokens();
        vi.setSystemTime(server + offset);
        const fetch = vi.fn(async () => mintResponse('org_1', server));
        vi.stubGlobal('fetch', fetch);
        await workbenchToken('org_1', 'c');
        await workbenchToken('org_1', 'c');
        await workbenchToken('org_1', 'c');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(dueIn('org_1')).toBe(RENEW_MS);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the lifetime from Date and expiresAt, and assumes 15 minutes without a Date', () => {
    const server = Date.UTC(2026, 10, 26, 12, 0, 0);
    expect(serverTtl(server + 5 * 60_000, new Date(server).toUTCString())).toBe(5 * 60_000);
    expect(serverTtl(server, null)).toBe(15 * 60_000);
  });

  it('tells subscribers after every mint, so the renewal timer plans again', async () => {
    const server = Date.now();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mintResponse('org_1', server)),
    );
    const seen = vi.fn();
    const off = onTokenMinted(seen);
    await workbenchToken('org_1', 'c');
    expect(seen).toHaveBeenCalledTimes(1);
    await workbenchToken('org_1', 'c', true);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });

  it('L3: a late 401 for the old token leaves the new one held', async () => {
    const server = Date.now();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mintResponse('org_1', server)),
    );
    const first = await workbenchToken('org_1', 'c');
    const second = await workbenchToken('org_1', 'c', true);
    dropToken('org_1', first);
    expect(dueIn('org_1')).not.toBeNull();
    dropToken('org_1', second);
    expect(dueIn('org_1')).toBeNull();
  });

  it('L4: a mint that was in flight when the person changed never lands', async () => {
    let release: (res: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    const pending = workbenchToken('org_1', 'c');
    forgetTokens();
    release(mintResponse('org_1', Date.now()));
    await expect(pending).rejects.toThrow(/superseded/);
    expect(dueIn('org_1')).toBeNull();
  });
});

describe('the token never gives way to the cookie (R1 M1, L14)', () => {
  it('sends the bound cookie with the bearer, strips every case of the mode header, sets authorization last', async () => {
    const fetch = vi.fn(async () => json({ ok: true }));
    const call = createBearerFetch({
      orgId: 'org_1',
      token: async () => 'pbtry_good',
      drop: () => undefined,
      fetch,
    });
    await call('/api/v1/passes', {
      headers: { 'x-passbook-MODE': 'live', Authorization: 'Bearer pbk_attacker' },
    });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('same-origin');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer pbtry_good');
    expect(Object.keys(headers).filter((h) => /mode/i.test(h))).toEqual([]);
  });

  it('a token that cannot be minted sends no request at all, not a cookie-only one', async () => {
    const fetch = vi.fn();
    const call = createBearerFetch({
      orgId: 'org_1',
      token: async () => {
        throw new ApiError({ status: 401, code: 'unauthenticated' });
      },
      drop: () => undefined,
      fetch,
    });
    await expect(call('/api/v1/passes')).rejects.toBeInstanceOf(ApiError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('after a 401 and a failed re-mint, still no cookie-only request', async () => {
    let n = 0;
    const fetch = vi.fn(async () => json({}, 401));
    const call = createBearerFetch({
      orgId: 'org_1',
      token: async () => {
        if (n++ > 0) throw new ApiError({ status: 401, code: 'unauthenticated' });
        return 't1';
      },
      drop: () => undefined,
      fetch,
    });
    await expect(call('/api/v1/passes')).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
