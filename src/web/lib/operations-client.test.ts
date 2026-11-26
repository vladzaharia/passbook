import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetSessionEnded,
  setCsrfProvider,
  setSessionPrincipalProvider,
  useSessionEnded,
} from './api.ts';
import { resetModeForTests } from './mode.ts';
import { createSessionOperationsClient } from './operations-client.ts';
import { dismissStepUp, pendingStepUp } from './step-up.ts';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

afterEach(() => {
  setCsrfProvider(async () => undefined);
  setSessionPrincipalProvider(() => undefined);
  resetSessionEnded();
  resetModeForTests();
  dismissStepUp();
});

describe('the SPA operations client', () => {
  it('sends the session CSRF token and an idempotency key on writes, and nothing on reads', async () => {
    setCsrfProvider(async () => 'tok');
    const fetch = vi.fn(async () => json(200, { operation: { id: 'o' } }));
    const client = createSessionOperationsClient(fetch as unknown as typeof globalThis.fetch);
    await client.cancel('o');
    const post = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const h = post[1].headers as Record<string, string>;
    expect(h['x-csrf-token']).toBe('tok');
    expect(h['idempotency-key']).toBeTruthy();
    await client.get('o', {});
    const get = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect((get[1].headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
  });

  it('answers an unchanged revision (304) with no operation and keeps the etag', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 304 }));
    const client = createSessionOperationsClient(fetch as unknown as typeof globalThis.fetch);
    const res = await client.get('o', { etag: '"o:3"' });
    expect(res).toEqual({ operation: null, etag: '"o:3"' });
    const sent = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((sent[1].headers as Record<string, string>)['if-none-match']).toBe('"o:3"');
  });

  it('ends the session on a 401 for the current principal', async () => {
    setSessionPrincipalProvider(() => 'a');
    const { result } = renderHook(() => useSessionEnded());
    const fetch = vi.fn(async () => json(401, { code: 'unauthenticated' }));
    const client = createSessionOperationsClient(fetch as unknown as typeof globalThis.fetch);
    await expect(client.get('o', {})).rejects.toMatchObject({ status: 401 });
    expect(result.current).toBe(true);
  });

  it('ignores a 401 that answers a principal who has since signed out', async () => {
    let principal: string | undefined = 'a';
    setSessionPrincipalProvider(() => principal);
    const { result } = renderHook(() => useSessionEnded());
    const fetch = vi.fn(async () => {
      principal = 'b';
      return json(401, { code: 'unauthenticated' });
    });
    const client = createSessionOperationsClient(fetch as unknown as typeof globalThis.fetch);
    await expect(client.get('o', {})).rejects.toMatchObject({ status: 401 });
    expect(result.current).toBe(false);
  });

  it('opens the step-up dialog when a stop needs a fresh sign-in', async () => {
    const fetch = vi.fn(async () =>
      json(403, {
        type: 'about:blank',
        title: 'Sign in again',
        status: 403,
        code: 'STEP_UP_REQUIRED',
        detail: 'Sign in again to stop this.',
        signInUrl: '/auth/step-up?next=x',
      }),
    );
    const client = createSessionOperationsClient(fetch as unknown as typeof globalThis.fetch);
    await expect(client.cancel('o')).rejects.toMatchObject({ status: 403 });
    expect(pendingStepUp()).toBe('/auth/step-up?next=x');
  });
});
