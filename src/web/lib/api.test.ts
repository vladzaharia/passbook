import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  api,
  buildUrl,
  createApiClient,
  endSession,
  resetSessionEnded,
  sessionEndedHref,
  setCsrfProvider,
  setSessionPrincipalProvider,
  useSessionEnded,
} from './api.ts';
import { ApiError, errorMessage, problemToError } from './errors.ts';
import { createQueryClient } from './query-client.ts';
import { sessionQuery } from './session.ts';

const Item = z.object({ id: z.string() });

function client(
  response: Response | (() => Response | Promise<Response>),
  csrf: string | null = 'tok',
  getSessionPrincipal: () => string | undefined = () => 'user-a',
) {
  const fetch = vi.fn(async () => (typeof response === 'function' ? response() : response.clone()));
  const onUnauthorized = vi.fn();
  const api = createApiClient({
    fetch: fetch as unknown as typeof globalThis.fetch,
    getCsrfToken: async () => csrf ?? undefined,
    getSessionPrincipal,
    onUnauthorized,
  });
  return { api, fetch, onUnauthorized };
}

function problemResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

function unauthorized() {
  return problemResponse(401, {
    type: 'about:blank',
    title: 'Unauthorized',
    status: 401,
    code: 'unauthenticated',
    detail: 'Sign in.',
  });
}

function authenticatedSession(id: string) {
  return {
    authenticated: true as const,
    user: { id, name: 'Test User', primaryEmail: 'test@example.com' },
    roles: ['user' as const],
    csrfToken: 'csrf-test',
    amr: 'oidc' as const,
    expiresAt: 4_000_000_000_000,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('parses a response with the zod schema', async () => {
    const { api, fetch } = client(new Response(JSON.stringify({ id: 'a' })));
    await expect(api.get('/x', Item)).resolves.toEqual({ id: 'a' });
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
  });

  it('sends the CSRF token on writes only', async () => {
    const { api, fetch } = client(new Response(JSON.stringify({ id: 'a' })));
    await api.post('/x', Item, { a: 1 });
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('tok');
    expect(headers['content-type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });

  it('omits the CSRF header when there is no session token', async () => {
    const { api, fetch } = client(new Response('{"id":"a"}'), null);
    await api.post('/x', Item);
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).not.toHaveProperty('x-csrf-token');
  });

  it('sends If-Match', async () => {
    const { api, fetch } = client(new Response('{"id":"a"}'));
    await api.patch('/x', Item, {}, { ifMatch: '"3"' });
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['if-match']).toBe('"3"');
  });

  it('maps problem+json to ApiError with code and field errors', async () => {
    const { api } = client(
      problemResponse(422, {
        type: 't',
        title: 'Invalid',
        status: 422,
        code: 'validation_failed',
        detail: 'Check the fields.',
        requestId: 'r1',
        issues: [
          { path: 'email', message: 'Invalid email' },
          { path: 'email', message: 'ignored duplicate' },
          { path: 'name', message: 'Required' },
        ],
      }),
    );
    const error = await api.post('/x', Item, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const e = error as ApiError;
    expect(e.status).toBe(422);
    expect(e.code).toBe('validation_failed');
    expect(e.requestId).toBe('r1');
    expect(e.fields).toEqual({ email: 'Invalid email', name: 'Required' });
    expect(e.message).toBe('Check the fields.');
  });

  it('calls onUnauthorized for the current principal on 401 and still throws', async () => {
    const { api, onUnauthorized } = client(
      problemResponse(401, {
        type: 't',
        title: 'x',
        status: 401,
        code: 'unauthenticated',
        detail: 'Sign in.',
      }),
    );
    await expect(api.get('/x', Item)).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(onUnauthorized).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, code: 'unauthenticated' }),
    );
  });

  it('retains the injected client 401 callback when no principal getter is configured', async () => {
    const onUnauthorized = vi.fn();
    const legacy = createApiClient({
      fetch: async () => unauthorized(),
      getCsrfToken: async () => undefined,
      onUnauthorized,
    });
    await expect(legacy.get('/x', Item)).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE JSON', 'DELETE', 'action'] as const)(
    'throws but does not end a new principal on a late %s 401',
    async (method) => {
      // The web test target is ES2023, before Promise.withResolvers.
      let resolve!: (response: Response) => void;
      const pending = new Promise<Response>((done) => {
        resolve = done;
      });
      let principal: string | undefined = 'user-a';
      const { api, fetch, onUnauthorized } = client(
        () => pending,
        'tok',
        () => principal,
      );
      const send = {
        GET: () => api.get('/x', Item),
        POST: () => api.post('/x', Item, { id: 'a' }),
        PUT: () => api.put('/x', Item, { id: 'a' }),
        PATCH: () => api.patch('/x', Item, { id: 'a' }),
        'DELETE JSON': () => api.deleteJson('/x', Item),
        DELETE: () => api.delete('/x'),
        action: () => api.action('POST', '/x', { id: 'a' }),
      };
      const rejected = expect(send[method]()).rejects.toMatchObject({
        status: 401,
        code: 'unauthenticated',
      });
      // Writes first await CSRF; release the response only after the request was dispatched.
      await Promise.resolve();
      expect(fetch).toHaveBeenCalledOnce();
      principal = 'user-b';
      resolve(unauthorized());
      await rejected;
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );

  it('checks the principal after reading a delayed 401 body', async () => {
    let resolveBody!: (body: string) => void;
    const body = new Promise<string>((done) => {
      resolveBody = done;
    });
    let startedReading!: () => void;
    const reading = new Promise<void>((done) => {
      startedReading = done;
    });
    const response = unauthorized();
    vi.spyOn(response, 'text').mockImplementation(() => {
      startedReading();
      return body;
    });
    let principal = 'user-a';
    const { api, onUnauthorized } = client(
      () => response,
      'tok',
      () => principal,
    );
    const rejected = expect(api.get('/x', Item)).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    await reading;
    principal = 'user-b';
    resolveBody(
      JSON.stringify({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        code: 'unauthenticated',
        detail: 'Sign in.',
      }),
    );
    await rejected;
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, undefined],
    [undefined, 'user-b'],
    ['user-a', undefined],
  ])('does not signal a session end from unknown principal %s to %s', async (before, after) => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    let principal: string | undefined = before;
    const { api, onUnauthorized } = client(
      () => pending,
      'tok',
      () => principal,
    );
    const rejected = expect(api.get('/x', Item)).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    principal = after;
    resolve(unauthorized());
    await rejected;
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it.each(['user-b', undefined])(
    'does not dispatch a write after its principal changes to %s during CSRF lookup',
    async (nextPrincipal) => {
      let resolveCsrf!: (token: string | undefined) => void;
      const csrf = new Promise<string | undefined>((done) => {
        resolveCsrf = done;
      });
      let principal: string | undefined = 'user-a';
      const fetch = vi.fn(async () => new Response('{"id":"a"}'));
      const onUnauthorized = vi.fn();
      const api = createApiClient({
        fetch: fetch as unknown as typeof globalThis.fetch,
        getCsrfToken: () => csrf,
        getSessionPrincipal: () => principal,
        onUnauthorized,
      });
      const rejected = expect(api.post('/x', Item, { id: 'a' })).rejects.toMatchObject({
        status: 409,
        code: 'session_changed',
        message: 'The signed-in account changed. Review your changes and try again.',
      });
      principal = nextPrincipal;
      resolveCsrf('tok');
      await rejected;
      expect(fetch).not.toHaveBeenCalled();
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );

  it('allows an initially anonymous write when a session appears during CSRF lookup', async () => {
    let resolveCsrf!: (token: string | undefined) => void;
    const csrf = new Promise<string | undefined>((done) => {
      resolveCsrf = done;
    });
    let principal: string | undefined;
    const fetch = vi.fn(async () => new Response('{"id":"a"}'));
    const api = createApiClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
      getCsrfToken: () => csrf,
      getSessionPrincipal: () => principal,
    });
    const result = api.post('/x', Item, { id: 'a' });
    principal = 'user-b';
    resolveCsrf('tok');
    await expect(result).resolves.toEqual({ id: 'a' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['user-a', true],
    ['user-b', false],
  ] as const)(
    'uses the principal discovered during CSRF lookup when the current principal is %s',
    async (principalAtResponse, shouldEnd) => {
      let resolveResponse!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
      let principal: string | undefined;
      const fetch = vi.fn(async () => response);
      const onUnauthorized = vi.fn();
      const api = createApiClient({
        fetch: fetch as unknown as typeof globalThis.fetch,
        getCsrfToken: async () => {
          principal = 'user-a';
          return 'tok';
        },
        getSessionPrincipal: () => principal,
        onUnauthorized,
      });
      const rejected = expect(api.post('/x', Item, {})).rejects.toMatchObject({
        status: 401,
        code: 'unauthenticated',
      });
      await Promise.resolve();
      expect(fetch).toHaveBeenCalledOnce();
      principal = principalAtResponse;
      resolveResponse(unauthorized());
      await rejected;
      expect(onUnauthorized).toHaveBeenCalledTimes(shouldEnd ? 1 : 0);
    },
  );

  it('preserves an abort when the principal changes during CSRF lookup', async () => {
    let resolveCsrf!: (token: string | undefined) => void;
    const csrf = new Promise<string | undefined>((done) => {
      resolveCsrf = done;
    });
    let principal = 'user-a';
    const fetch = vi.fn(async () => new Response('{"id":"a"}'));
    const api = createApiClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
      getCsrfToken: () => csrf,
      getSessionPrincipal: () => principal,
    });
    const controller = new AbortController();
    const reason = new DOMException('aborted', 'AbortError');
    const rejected = expect(api.post('/x', Item, {}, { signal: controller.signal })).rejects.toBe(
      reason,
    );
    controller.abort(reason);
    principal = 'user-b';
    resolveCsrf('tok');
    await rejected;
    expect(fetch).not.toHaveBeenCalled();
  });

  it('propagates a CSRF lookup failure without dispatching the write', async () => {
    const cause = new Error('CSRF lookup failed');
    const fetch = vi.fn(async () => new Response('{"id":"a"}'));
    const api = createApiClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
      getCsrfToken: async () => {
        throw cause;
      },
      getSessionPrincipal: () => 'user-a',
    });
    await expect(api.post('/x', Item, {})).rejects.toBe(cause);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not call onUnauthorized on 403', async () => {
    const { api, onUnauthorized } = client(
      problemResponse(403, {
        type: 't',
        title: 'x',
        status: 403,
        code: 'forbidden',
        detail: 'No.',
      }),
    );
    const error = (await api.get('/x', Item).catch((e: unknown) => e)) as ApiError;
    expect(error.isForbidden).toBe(true);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('maps a non-problem error body by status', async () => {
    const { api } = client(new Response('<html>bad gateway</html>', { status: 502 }));
    const error = (await api.get('/x', Item).catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(502);
    expect(error.code).toBe('server_error');
    expect(error.isTransient).toBe(true);
    expect(errorMessage(error)).toBe('Something went wrong. Try again.');
  });

  it('maps a network failure to status 0', async () => {
    const { api } = client(() => {
      throw new TypeError('Failed to fetch');
    });
    const error = (await api.get('/x', Item).catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 0, code: 'network' });
    expect(errorMessage(error)).toMatch(/reach PassBook/);
  });

  it('rethrows aborts untouched', async () => {
    const controller = new AbortController();
    controller.abort();
    const { api } = client(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(api.get('/x', Item, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects a response that fails the schema', async () => {
    const { api } = client(new Response(JSON.stringify({ id: 5 })));
    await expect(api.get('/x?q=1', Item)).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response',
      message: 'Unexpected response from /x.',
    });
  });

  it('handles empty bodies for action and delete', async () => {
    const { api } = client(new Response(null, { status: 204 }));
    await expect(api.delete('/x')).resolves.toBeUndefined();
    await expect(api.action('POST', '/y')).resolves.toBeUndefined();
  });

  it('passes FormData through without a JSON content type', async () => {
    const { api, fetch } = client(new Response('{"id":"a"}'));
    const body = new FormData();
    body.set('file', new Blob(['x']), 'a.txt');
    await api.post('/x', Item, body);
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe(body);
    expect(init.headers).not.toHaveProperty('content-type');
  });
});

describe('buildUrl', () => {
  it('skips empty values and appends to an existing query', () => {
    expect(
      buildUrl('/a', { q: 'x y', n: 2, none: undefined, nul: null, empty: '', f: false }),
    ).toBe('/a?q=x+y&n=2&f=false');
    expect(buildUrl('/a?x=1', { y: 2 })).toBe('/a?x=1&y=2');
    expect(buildUrl('/a')).toBe('/a');
  });
});

describe('problemToError', () => {
  it('falls back to a generic client error', () => {
    const e = problemToError(400, 'nope');
    expect(e).toMatchObject({ status: 400, code: 'request_failed' });
    expect(e.isConflict).toBe(false);
    expect(problemToError(412, undefined).isConflict).toBe(true);
  });
});

describe('errorMessage', () => {
  it('passes a written sentence through, so it never wraps twice', () => {
    expect(errorMessage('Allow clipboard access and try again.')).toBe(
      'Allow clipboard access and try again.',
    );
    const conflict = new ApiError({ status: 409, code: 'x', detail: 'Taken.' });
    expect(errorMessage(errorMessage(conflict))).toBe('Taken.');
  });

  it('never leaks unknown errors', () => {
    expect(errorMessage(new Error('secret stack'))).toBe('Something went wrong. Try again.');
    expect(errorMessage(new ApiError({ status: 403, code: 'forbidden' }))).toBe(
      'You do not have access.',
    );
  });
});

describe('session end', () => {
  afterEach(() => {
    resetSessionEnded();
    setCsrfProvider(async () => undefined);
    setSessionPrincipalProvider(() => undefined);
  });

  it('flips once, however many requests come back 401', () => {
    const { result } = renderHook(() => useSessionEnded());
    expect(result.current).toBe(false);
    act(() => {
      endSession();
      endSession();
    });
    expect(result.current).toBe(true);
  });

  it('clears an earlier session-ended notice only when the authenticated user changes', async () => {
    const queryClient = createQueryClient();
    let session = authenticatedSession('user-a');
    queryClient.setQueryData(sessionQuery.queryKey, session);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(session))),
    );
    const { result } = renderHook(() => useSessionEnded());
    act(() => endSession());
    expect(result.current).toBe(true);

    await act(async () => {
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    });
    expect(result.current).toBe(true);

    session = authenticatedSession('user-b');
    await act(async () => {
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    });
    expect(result.current).toBe(false);
    queryClient.clear();
  });

  it('keeps the new session live when cancelling an old query releases a 401', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(sessionQuery.queryKey, authenticatedSession('user-a'));
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((done) => {
      resolveOld = done;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/old') return oldResponse;
        if (String(input) === '/api/v1/session') {
          return new Response(JSON.stringify(authenticatedSession('user-b')));
        }
        return unauthorized();
      }),
    );
    const { result } = renderHook(() => useSessionEnded());
    const oldRejected = expect(api.get('/old', Item)).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    let principalAtCancel: string | undefined;
    const cancelled = queryClient
      .fetchQuery({
        queryKey: ['pending-old'],
        retry: false,
        queryFn: ({ signal }) =>
          new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                const session = queryClient.getQueryData(sessionQuery.queryKey);
                principalAtCancel = session?.authenticated ? session.user.id : undefined;
                resolveOld(unauthorized());
                resolve();
              },
              { once: true },
            );
          }),
      })
      .catch(() => undefined);
    await act(async () => {
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
      await cancelled;
      await oldRejected;
    });
    expect(principalAtCancel).toBe('user-b');
    expect(result.current).toBe(false);

    await act(async () => {
      await expect(api.get('/current', Item)).rejects.toMatchObject({
        status: 401,
        code: 'unauthenticated',
      });
    });
    expect(result.current).toBe(true);
    queryClient.clear();
  });

  it('ignores a late 401 from before an A to B to A principal switch', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(sessionQuery.queryKey, authenticatedSession('user-a'));
    let current = authenticatedSession('user-b');
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((done) => {
      resolveOld = done;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === '/old') return oldResponse;
        if (String(input) === '/api/v1/session') return new Response(JSON.stringify(current));
        return unauthorized();
      }),
    );
    const { result } = renderHook(() => useSessionEnded());
    const oldRejected = expect(api.get('/old', Item)).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });

    await act(async () => {
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
      current = authenticatedSession('user-a');
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
      resolveOld(unauthorized());
      await oldRejected;
    });
    expect(result.current).toBe(false);

    await act(async () => {
      await expect(api.get('/current', Item)).rejects.toMatchObject({ status: 401 });
    });
    expect(result.current).toBe(true);
    queryClient.clear();
  });

  it('ends a known session when its own background refresh returns 401', async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(sessionQuery.queryKey, authenticatedSession('user-a'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => unauthorized()),
    );
    const { result } = renderHook(() => useSessionEnded());
    await act(async () => {
      await expect(
        queryClient.fetchQuery({ ...sessionQuery, staleTime: 0, retry: false }),
      ).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    });
    expect(result.current).toBe(true);
    queryClient.clear();
  });

  it('throws an initial session 401 without ending an unknown session', async () => {
    const queryClient = createQueryClient();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => unauthorized()),
    );
    const { result } = renderHook(() => useSessionEnded());
    await act(async () => {
      await expect(queryClient.fetchQuery({ ...sessionQuery, retry: false })).rejects.toMatchObject(
        {
          status: 401,
          code: 'unauthenticated',
        },
      );
    });
    expect(result.current).toBe(false);
    queryClient.clear();
  });

  it('builds a sign-in that returns here and says why', () => {
    expect(sessionEndedHref('/admin/orgs/o1?tab=settings')).toBe(
      '/login?next=%2Fadmin%2Forgs%2Fo1%3Ftab%3Dsettings&reason=expired',
    );
    expect(sessionEndedHref('/')).toBe('/login?reason=expired');
    expect(sessionEndedHref('//evil.example')).toBe('/login?reason=expired');
  });
});
