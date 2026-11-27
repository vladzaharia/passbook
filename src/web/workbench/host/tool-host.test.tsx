import { act, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api as sessionApi } from '../../lib/api.ts';
import { ApiError } from '../../lib/errors.ts';
import { useToolApi, useToolMode, useToolScope } from '../../lib/tool-api.tsx';
import type { WbContext } from './contexts.ts';
import { forgetTokens, RENEW_MS, workbenchToken } from './token.ts';
import { ToolHostProvider } from './tool-host.tsx';

vi.mock('../../lib/session.ts', () => ({
  useSession: () => ({ authed: { csrfToken: 'csrf-1', user: { id: 'u1' } } }),
}));

const nw: WbContext = {
  orgId: 'nw',
  name: 'Northwind',
  kind: 'org',
  tools: ['home'],
  closed: false,
  timeZone: 'America/Los_Angeles',
};

afterEach(() => {
  forgetTokens();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const wrap = (context: WbContext | null) => (props: { children: ReactNode }) => (
  <ToolHostProvider context={context}>{props.children}</ToolHostProvider>
);

describe('the pinned tool scope (R4 H2)', () => {
  it('with no context, a tool gets a client that refuses, never the session client', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(
      () => ({ api: useToolApi(), mode: useToolMode(), scope: useToolScope() }),
      {
        wrapper: wrap(null),
      },
    );
    expect(result.current.api).not.toBe(sessionApi);
    expect(result.current.mode).toBe('test');
    expect(result.current.scope?.orgId).toBeUndefined();
    const refused = await result.current.api
      .get('/api/v1/passes', z.unknown())
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe('no_context');
    await expect(result.current.api.action('POST', '/api/v1/passes')).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('with a context, the token client in Test for that org', () => {
    const { result } = renderHook(
      () => ({ api: useToolApi(), mode: useToolMode(), scope: useToolScope() }),
      {
        wrapper: wrap(nw),
      },
    );
    expect(result.current.api).not.toBe(sessionApi);
    expect(result.current.scope?.orgId).toBe('nw');
    expect(result.current.mode).toBe('test');
  });
});

describe('the renewal timer (R4 M3)', () => {
  it('plans after the first mint and again after every renewal, with no visibility change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let n = 0;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { orgId } = JSON.parse(String(init.body)) as { orgId: string };
      return new Response(
        JSON.stringify({
          token: `pbtry_${n++}`,
          orgId,
          mode: 'test',
          expiresAt: Date.now() + 15 * 60_000,
          subject: 'member',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', date: new Date().toUTCString() },
        },
      );
    });
    vi.stubGlobal('fetch', fetch);
    render(<ToolHostProvider context={nw}>{null}</ToolHostProvider>);
    // Mounted with no token held; the first mint is a tool's call, not the timer's.
    await act(async () => {
      await workbenchToken('nw', 'csrf-1');
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENEW_MS + 50);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RENEW_MS + 50);
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
