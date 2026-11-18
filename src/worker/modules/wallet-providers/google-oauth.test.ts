import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_WALLET_SCOPE,
  type GoogleValidatedAccount,
  validateGoogleAccount,
} from './google-credentials.ts';
import { GOOGLE_FETCH_TIMEOUT_MS, googleFetch, parseRetryAfter } from './google-errors.ts';
import { dropGoogleAccessToken, getGoogleAccessToken } from './google-oauth.ts';

const now = 1_700_000_000;
let account: GoogleValidatedAccount;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  );
  const base64 = btoa(Array.from(der, (byte) => String.fromCharCode(byte)).join(''));
  account = await validateGoogleAccount({
    issuerId: '33880000000223344',
    serviceAccountEmail: 'wallet-service@example-project.iam.gserviceaccount.com',
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`,
    scopes: [GOOGLE_WALLET_SCOPE],
  });
});
beforeEach(() => dropGoogleAccessToken());

/** Each mint returns a distinct token so a reuse is visible in the result. */
function tokenFetcher(expiresIn = 3600) {
  let minted = 0;
  return vi.fn(async () =>
    Response.json({
      access_token: `ya29.token-${++minted}`,
      token_type: 'Bearer',
      expires_in: expiresIn,
    }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('Google access token cache (G1)', () => {
  const key = { accountId: 'account-a', revision: 1 };

  it('mints every time without a cache key', async () => {
    const fetcher = tokenFetcher();
    await getGoogleAccessToken(account, { issuedAt: now, fetcher });
    await getGoogleAccessToken(account, { issuedAt: now, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reuses a token until 80 percent of expires_in, then mints a new one', async () => {
    const fetcher = tokenFetcher(3600);
    const first = await getGoogleAccessToken(account, { issuedAt: now, fetcher, cacheKey: key });
    const reused = await getGoogleAccessToken(account, {
      issuedAt: now + 2879,
      fetcher,
      cacheKey: key,
    });
    expect(reused).toEqual(first);
    expect(reused.expiresAt).toBe(now + 3600);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const renewed = await getGoogleAccessToken(account, {
      issuedAt: now + 2880,
      fetcher,
      cacheKey: key,
    });
    expect(renewed.accessToken).toBe('ya29.token-2');
    expect(renewed.expiresAt).toBe(now + 2880 + 3600);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('drops the token on request, as after a 401', async () => {
    const fetcher = tokenFetcher();
    await getGoogleAccessToken(account, { issuedAt: now, fetcher, cacheKey: key });
    dropGoogleAccessToken(key.accountId);
    const next = await getGoogleAccessToken(account, { issuedAt: now + 1, fetcher, cacheKey: key });
    expect(next.accessToken).toBe('ya29.token-2');
  });

  it('never shares a token across credential revisions or accounts', async () => {
    const fetcher = tokenFetcher();
    const one = await getGoogleAccessToken(account, { issuedAt: now, fetcher, cacheKey: key });
    const rotated = await getGoogleAccessToken(account, {
      issuedAt: now + 1,
      fetcher,
      cacheKey: { ...key, revision: 2 },
    });
    const other = await getGoogleAccessToken(account, {
      issuedAt: now + 1,
      fetcher,
      cacheKey: { accountId: 'account-b', revision: 1 },
    });
    expect(new Set([one.accessToken, rotated.accessToken, other.accessToken]).size).toBe(3);
    // The old revision's token was discarded when the revision changed.
    const back = await getGoogleAccessToken(account, { issuedAt: now + 2, fetcher, cacheKey: key });
    expect(back.accessToken).not.toBe(one.accessToken);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('does not cache a failed exchange and never stores or logs the token', async () => {
    const log = vi.spyOn(console, 'log');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(
        Response.json({ access_token: 'ya29.ok', token_type: 'Bearer', expires_in: 3600 }),
      ) as unknown as typeof fetch;
    await expect(
      getGoogleAccessToken(account, { issuedAt: now, fetcher, cacheKey: key }),
    ).rejects.toMatchObject({ code: 'server_error' });
    const token = await getGoogleAccessToken(account, { issuedAt: now, fetcher, cacheKey: key });
    expect(token.accessToken).toBe('ya29.ok');
    expect(JSON.stringify(log.mock.calls)).not.toContain('ya29.ok');
    log.mockRestore();
  });
});

describe('Google request timeout and Retry-After (G13)', () => {
  it('bounds the OAuth exchange with the 10 s timeout signal', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return Response.json({ access_token: 'ya29.t', token_type: 'Bearer', expires_in: 60 });
    }) as unknown as typeof fetch;
    await getGoogleAccessToken(account, { issuedAt: now, fetcher });
    expect(GOOGLE_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it('reports a timeout as its own code and a caller abort as a network failure', async () => {
    const hang = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    await expect(googleFetch(hang, 'https://example.test/', {}, 'probe', 5)).rejects.toMatchObject({
      code: 'timeout',
      operation: 'probe',
    });
    const controller = new AbortController();
    const pending = googleFetch(
      hang,
      'https://example.test/',
      { signal: controller.signal },
      'probe',
    );
    controller.abort(new Error('caller gave up'));
    await expect(pending).rejects.toMatchObject({ code: 'network' });
  });

  it('carries Retry-After from a rate-limited OAuth response', async () => {
    const limited = (async () =>
      new Response('{}', { status: 429, headers: { 'retry-after': '7' } })) as typeof fetch;
    await expect(
      getGoogleAccessToken(account, { issuedAt: now, fetcher: limited }),
    ).rejects.toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 7000 });
  });

  it('parses seconds and HTTP dates, and ignores junk or unrelated statuses', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter(' 3 ')).toBe(3000);
    expect(parseRetryAfter('99999999')).toBeUndefined();
    expect(parseRetryAfter('999999')).toBe(3_600_000);
    expect(parseRetryAfter('-1')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    const at = Date.UTC(2026, 0, 1, 0, 0, 30);
    expect(parseRetryAfter(new Date(at).toUTCString(), Date.UTC(2026, 0, 1))).toBe(30_000);
    expect(parseRetryAfter(new Date(at).toUTCString(), at + 5000)).toBe(0);
    expect(parseRetryAfter(new Date(at).toUTCString())).toBeUndefined();
  });
});
