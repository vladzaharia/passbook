import { describe, expect, it, vi } from 'vitest';
import { ScanOutcomeSchema } from '../../../shared/contracts/scan.ts';
import { sessionFixture } from '../boot/session.test-support.ts';
import { fixtureCounts, fixtureOutcome } from '../machine/fixture-data.test-support.ts';
import { createScanApi, ScanApiError } from './scan-api.ts';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  });
  let csrf: string | undefined = 'csrf-1';
  const api = createScanApi({
    fetch: fetchFn as unknown as typeof fetch,
    csrf: () => csrf,
    sleep: async () => {},
  });
  return { api, calls, fetchFn, setCsrf: (v: string | undefined) => (csrf = v) };
}

const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

describe('createScanApi', () => {
  it('act posts the body with the csrf token from the session and parses the outcome', async () => {
    const outcome = ScanOutcomeSchema.parse(fixtureOutcome('ok'));
    const { api, calls } = setup(() => json(outcome));
    const body = {
      idempotencyKey: '01900000-0000-7000-8000-000000000001',
      input: { code: 'ABC', method: 'camera' as const },
      clientTs: 1,
      actionId: 'auto',
    };
    const got = await api.act(body, { signal: new AbortController().signal });
    expect(got.kind).toBe('ok');
    expect(calls[0]?.url).toBe('/api/v1/scan/actions');
    expect(calls[0]?.init.method).toBe('POST');
    expect(header(calls[0]?.init as RequestInit, 'x-csrf-token')).toBe('csrf-1');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual(body);
    expect(calls[0]?.init.credentials).toBe('same-origin');
  });

  it('sends no csrf header on a GET, or when the session has none', async () => {
    const { api, calls, setCsrf } = setup(() => json(fixtureCounts()));
    await api.stats({ signal: new AbortController().signal, dayStart: 5 });
    expect(calls[0]?.url).toBe('/api/v1/scan/stats?dayStart=5');
    expect(header(calls[0]?.init as RequestInit, 'x-csrf-token')).toBeUndefined();
    setCsrf(undefined);
    await api.signOut();
    expect(header(calls[1]?.init as RequestInit, 'x-csrf-token')).toBeUndefined();
  });

  it('puts an admin scope on a GET as a query, never a code or a name', async () => {
    const { api, calls } = setup(() => json(sessionFixture()));
    await api.session({
      orgId: 'org1',
      eventId: 'ev1',
      templateIds: ['a', 'b'],
      timeZone: 'Europe/Berlin',
    });
    expect(calls[0]?.url).toBe(
      '/api/v1/scan/session?orgId=org1&eventId=ev1&templateIds=a%2Cb&timeZone=Europe%2FBerlin',
    );
  });

  it('lookup is a POST so a name never sits in a URL', async () => {
    const { api, calls } = setup(() => json({ items: [], more: false }));
    await api.lookup({ q: 'anna' });
    expect(calls[0]?.url).toBe('/api/v1/scan/lookup');
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('maps a 429 to ScanApiError with Retry-After in ms', async () => {
    const { api } = setup(() =>
      json(
        { code: 'RATE_LIMITED', title: 'Too many', status: 429 },
        { status: 429, headers: { 'retry-after': '7' } },
      ),
    );
    const error = await api
      .stats({ signal: new AbortController().signal })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScanApiError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 7000 });
  });

  it('a 401 carries the problem code', async () => {
    const { api } = setup(() =>
      json({ code: 'SCANNER_REVOKED', title: 'Revoked', status: 401 }, { status: 401 }),
    );
    await expect(api.signOut()).rejects.toMatchObject({ status: 401, code: 'SCANNER_REVOKED' });
  });

  it('retries a 409 SCAN_IN_PROGRESS once with the same body', async () => {
    let n = 0;
    const outcome = ScanOutcomeSchema.parse(fixtureOutcome('ok'));
    const { api, calls } = setup(() =>
      ++n === 1
        ? json(
            { code: 'SCAN_IN_PROGRESS', title: 'Busy', status: 409 },
            { status: 409, headers: { 'retry-after': '1' } },
          )
        : json(outcome),
    );
    const body = {
      idempotencyKey: '01900000-0000-7000-8000-000000000001',
      input: { code: 'ABC', method: 'camera' as const },
      clientTs: 1,
      actionId: 'auto',
    };
    await api.act(body, { signal: new AbortController().signal });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init.body).toBe(calls[0]?.init.body);
  });

  it('gives up after one retry', async () => {
    const { api, calls } = setup(() =>
      json({ code: 'PASS_CONFLICT', title: 'Busy', status: 409 }, { status: 409 }),
    );
    const body = {
      idempotencyKey: '01900000-0000-7000-8000-000000000001',
      input: { code: 'ABC', method: 'camera' as const },
      clientTs: 1,
      actionId: 'auto',
    };
    await expect(api.act(body, { signal: new AbortController().signal })).rejects.toMatchObject({
      status: 409,
    });
    expect(calls).toHaveLength(2);
  });

  it('a network failure is status 0; an abort is rethrown as is', async () => {
    const fail = createScanApi({
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      csrf: () => undefined,
    });
    await expect(fail.signOut()).rejects.toMatchObject({ status: 0, code: 'network' });
    const ac = new AbortController();
    const aborting = createScanApi({
      fetch: (async () => {
        ac.abort();
        throw new DOMException('aborted', 'AbortError');
      }) as unknown as typeof fetch,
      csrf: () => undefined,
    });
    await expect(aborting.stats({ signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('an unexpected response body is an invalid_response error', async () => {
    const { api } = setup(() => json({ nope: true }));
    await expect(api.stats({ signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('has a call for every device route', () => {
    const { api } = setup(() => json({}));
    expect(Object.keys(api).sort()).toEqual(
      [
        'act',
        'activity',
        'reportDevice',
        'batch',
        'lookup',
        'pair',
        'pairPreview',
        'recent',
        'resolve',
        'roster',
        'session',
        'signOut',
        'staffSignIn',
        'staffSignOut',
        'stats',
        'summary',
        'undo',
      ].sort(),
    );
  });
});
