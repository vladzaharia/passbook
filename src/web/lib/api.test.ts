import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  buildUrl,
  createApiClient,
  endSession,
  resetSessionEnded,
  sessionEndedHref,
  useSessionEnded,
} from './api.ts';
import { ApiError, errorMessage, problemToError } from './errors.ts';

const Item = z.object({ id: z.string() });

function client(
  response: Response | (() => Response | Promise<Response>),
  csrf: string | null = 'tok',
) {
  const fetch = vi.fn(async () => (typeof response === 'function' ? response() : response.clone()));
  const onUnauthorized = vi.fn();
  const api = createApiClient({
    fetch: fetch as unknown as typeof globalThis.fetch,
    getCsrfToken: async () => csrf ?? undefined,
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

  it('calls onUnauthorized on 401 and still throws', async () => {
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
  afterEach(() => resetSessionEnded());

  it('flips once, however many requests come back 401', () => {
    const { result } = renderHook(() => useSessionEnded());
    expect(result.current).toBe(false);
    act(() => {
      endSession();
      endSession();
    });
    expect(result.current).toBe(true);
  });

  it('builds a sign-in that returns here and says why', () => {
    expect(sessionEndedHref('/admin/orgs/o1?tab=settings')).toBe(
      '/login?next=%2Fadmin%2Forgs%2Fo1%3Ftab%3Dsettings&reason=expired',
    );
    expect(sessionEndedHref('/')).toBe('/login?reason=expired');
    expect(sessionEndedHref('//evil.example')).toBe('/login?reason=expired');
  });
});
