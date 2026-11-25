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

  describe('409 from a changed door', () => {
    const body = {
      idempotencyKey: '01900000-0000-7000-8000-000000000001',
      input: { code: 'ABC', method: 'camera' as const },
      clientTs: 1,
      actionId: 'auto',
    };
    const conflict = (code: string) =>
      json({ code, title: 'Changed', status: 409 }, { status: 409 });
    const withRefresh = (
      respond: (url: string, init: RequestInit) => Response,
      refreshConfig: () => Promise<void>,
    ) => {
      const calls: { url: string; init: RequestInit }[] = [];
      const api = createScanApi({
        fetch: (async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          return respond(url, init);
        }) as unknown as typeof fetch,
        csrf: () => 'csrf-1',
        sleep: async () => {},
        refreshConfig,
      });
      return { api, calls };
    };

    it('reloads the configuration and retries SCAN_CONFIG_CHANGED once with the same key', async () => {
      const outcome = ScanOutcomeSchema.parse(fixtureOutcome('ok'));
      const refresh = vi.fn(async () => {});
      let n = 0;
      const { api, calls } = withRefresh(
        () => (++n === 1 ? conflict('SCAN_CONFIG_CHANGED') : json(outcome)),
        refresh,
      );
      await api.act(body, { signal: new AbortController().signal });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.init.body).toBe(calls[0]?.init.body);
    });

    it('a session read refused for drift never waits on its own refetch', async () => {
      const refresh = vi.fn(() => new Promise<void>(() => {}));
      const { api, calls } = withRefresh(() => conflict('SCAN_CONFIG_CHANGED'), refresh);
      await expect(api.session()).rejects.toMatchObject({
        status: 409,
        code: 'SCAN_CONFIG_CHANGED',
      });
      expect(refresh).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    });

    it('a counts poll refused for drift reloads the configuration and reads again', async () => {
      const refresh = vi.fn(async () => {});
      let n = 0;
      const { api, calls } = withRefresh(
        () => (++n === 1 ? conflict('SCAN_CONFIG_CHANGED') : json(fixtureCounts())),
        refresh,
      );
      await expect(api.stats({ signal: new AbortController().signal })).resolves.toEqual(
        fixtureCounts(),
      );
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(calls.map((c) => c.url)).toEqual(['/api/v1/scan/stats', '/api/v1/scan/stats']);
    });

    it('only the second SCAN_CONFIG_CHANGED reaches the caller, and never as an unpair', async () => {
      const refresh = vi.fn(async () => {});
      const { api, calls } = withRefresh(() => conflict('SCAN_CONFIG_CHANGED'), refresh);
      await expect(api.act(body, { signal: new AbortController().signal })).rejects.toMatchObject({
        status: 409,
        code: 'SCAN_CONFIG_CHANGED',
      });
      expect(calls).toHaveLength(2);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(calls.some((c) => c.url.endsWith('/unpair'))).toBe(false);
    });

    it('drops the staff sign-in on SCAN_STAFF_CHANGED and reports it without retrying', async () => {
      const refresh = vi.fn(async () => {});
      const { api, calls } = withRefresh(
        (url, init) =>
          init.method === 'DELETE' && url.endsWith('/staff')
            ? json(sessionFixture())
            : conflict('SCAN_STAFF_CHANGED'),
        refresh,
      );
      await expect(api.act(body, { signal: new AbortController().signal })).rejects.toMatchObject({
        status: 409,
        code: 'SCAN_STAFF_CHANGED',
      });
      expect(calls.map((c) => `${c.init.method} ${c.url.split('/scan')[1]}`)).toEqual([
        'POST /actions',
        'DELETE /staff',
      ]);
      expect(refresh).toHaveBeenCalledTimes(1);
    });
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
        'addNote',
        'addPhoto',
        'deleteNote',
        'devices',
        'draftClear',
        'draftPut',
        'editNote',
        'reportDevice',
        'batch',
        'endRollCall',
        'history',
        'inside',
        'lookup',
        'markOut',
        'notes',
        'openNow',
        'override',
        'overrideNote',
        'pair',
        'pairPreview',
        'recent',
        'resolve',
        'rollCall',
        'rollCallMarks',
        'roster',
        'session',
        'setRole',
        'signOut',
        'signOutPerson',
        'staffNewPin',
        'staffSearch',
        'staffSignIn',
        'staffSignOut',
        'startRollCall',
        'stats',
        'summary',
        'tagBind',
        'tagComplete',
        'tagDecline',
        'tagInspect',
        'tagPending',
        'tagUndo',
        'undo',
        'visitors',
      ].sort(),
    );
  });

  it('puts and clears a draft', async () => {
    const { api, calls } = setup(() => json({ screens: 1 }));
    const ref = '01900000-0000-7000-8000-000000000001';
    await api.draftPut({ ref, actionId: 'charge', amount: 12 });
    await api.draftClear(ref, false);
    await api.draftClear(ref, true);
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['PUT', '/api/v1/scan/draft'],
      ['DELETE', `/api/v1/scan/draft?ref=${ref}`],
      ['DELETE', `/api/v1/scan/draft?ref=${ref}&keep=ready`],
    ]);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      ref,
      actionId: 'charge',
      amount: 12,
    });
  });

  describe('tags', () => {
    const tag = { uid: '04a2b3c4', tech: 'a' as const, source: 'native' as const };
    const bindBody = {
      idempotencyKey: '01900000-0000-7000-8000-000000000001',
      tag,
      card: { code: 'CARD-1', method: 'camera' as const },
      preview: true,
      binding: 'user' as const,
    };

    it('posts each call to its route with the csrf token', async () => {
      const { api, calls } = setup(() =>
        json({
          state: 'new',
          hint: 'B3C4',
          assurance: 'basic',
          bound: null,
          lostAt: null,
          boundAt: null,
          boundByName: null,
        }),
      );
      await api.tagInspect({ tag });
      await api.tagUndo('b/1').catch(() => undefined);
      await api.tagDecline('e1').catch(() => undefined);
      expect(calls.map((c) => c.url)).toEqual([
        '/api/v1/scan/tags/inspect',
        '/api/v1/scan/tags/bindings/b%2F1/undo',
        '/api/v1/scan/tag-enrollments/e1/decline',
      ]);
      expect(header(calls[0]?.init as RequestInit, 'x-csrf-token')).toBe('csrf-1');
    });

    it('keeps the binding scope in a bind body even for an admin, who is otherwise scoped', async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      const api = createScanApi({
        fetch: (async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          return json({});
        }) as unknown as typeof fetch,
        csrf: () => 'c',
        scope: () => ({ orgId: 'o1', timeZone: 'UTC' }),
      });
      await api.tagBind(bindBody).catch(() => undefined);
      expect(JSON.parse(calls[0]?.init.body as string).binding).toBe('user');
    });

    it('reads the pending request and a null one', async () => {
      const { api, calls } = setup(() => json({ enrollment: null }));
      expect(await api.tagPending()).toEqual({ enrollment: null });
      expect(calls[0]?.url).toBe('/api/v1/scan/tag-enrollments/pending');
      expect(calls[0]?.init.method).toBe('GET');
    });

    it('carries the server code of a refusal for the machine', async () => {
      const { api } = setup(() =>
        json({ code: 'TAG_HELD_BY_OTHER', title: 'held' }, { status: 409 }),
      );
      await expect(api.tagBind(bindBody)).rejects.toMatchObject({
        status: 409,
        code: 'TAG_HELD_BY_OTHER',
      });
    });
  });
});
