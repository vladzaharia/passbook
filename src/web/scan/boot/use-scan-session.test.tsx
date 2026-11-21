import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScanApi } from '../api/scan-api.ts';
import { fixtureState, states } from '../machine/fixtures.test-support.ts';
import { registerSync } from '../offline/sync-gate.ts';
import { resetPairLink } from './pair-link.ts';
import { sessionFixture } from './session.test-support.ts';
import { createCsrfHolder, needsSessionRefetch, useScanSession } from './use-scan-session.ts';

afterEach(() => {
  resetPairLink();
  window.history.replaceState(null, '', '/');
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('useScanSession (against a stub server)', () => {
  it('strips #pair= before the first request, then loads the session and keeps the csrf token in memory', async () => {
    window.history.replaceState(null, '', '/scan#pair=ABCD-EFGH-JKLM');
    const order: string[] = [];
    const replace = vi.spyOn(window.history, 'replaceState');
    replace.mockImplementation((...args) => {
      order.push('replaceState');
      return History.prototype.replaceState.apply(window.history, args);
    });
    const fetchFn = vi.fn(async () => {
      order.push('fetch');
      return json(sessionFixture());
    });
    const holder = createCsrfHolder();
    const api = createScanApi({ fetch: fetchFn as unknown as typeof fetch, csrf: holder.get });
    const { result } = renderHook(() => useScanSession(api, holder), { wrapper: wrapper() });
    expect(result.current.pairCode).toBe('ABCD-EFGH-JKLM');
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(order.indexOf('replaceState')).toBeLessThan(order.indexOf('fetch'));
    expect(window.location.hash).toBe('');
    expect(holder.get()).toBe('csrf-token-1');
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(
      'csrf-token-1',
    );
    replace.mockRestore();
  });

  const syncing = (flag: boolean) =>
    fixtureState({
      queue: { pending: 2, oldestAt: 1, conflicts: 0 },
      offline: { mode: 'list', listAt: null, syncing: flag },
    });
  const setup = () => {
    const fetchFn = vi.fn(async () => json(sessionFixture()));
    const holder = createCsrfHolder();
    const api = createScanApi({ fetch: fetchFn as unknown as typeof fetch, csrf: holder.get });
    const hook = renderHook(({ machine }) => useScanSession(api, holder, machine), {
      wrapper: wrapper(),
      initialProps: { machine: null as ReturnType<typeof fixtureState> | null },
    });
    return { fetchFn, ...hook };
  };
  const reconnect = () =>
    act(() => {
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });

  it('waits for the sync a reconnect starts: no session refetch before the queue is sent', async () => {
    const { fetchFn, result, rerender } = setup();
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    rerender({ machine: syncing(false) });
    const before = fetchFn.mock.calls.length;
    reconnect();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchFn.mock.calls.length).toBe(before);
  });

  it('polls again after a failed sync: a stuck queue does not hide the session', async () => {
    const { fetchFn, result, rerender } = setup();
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    rerender({ machine: syncing(true) });
    rerender({ machine: syncing(false) });
    const before = fetchFn.mock.calls.length;
    reconnect();
    await waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThan(before));
  });

  it('holds polls during a sync for 30 s at most, then polls on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { fetchFn, result, rerender } = setup();
      await waitFor(() => expect(result.current.phase).toBe('ready'));
      rerender({ machine: syncing(true) });
      const before = fetchFn.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_000);
      });
      expect(fetchFn.mock.calls.length).toBe(before);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      // The hold is over: the interval starts and fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(fetchFn.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the queue before a session poll when reads are queued, even with no offline event', async () => {
    const order: string[] = [];
    registerSync(async () => {
      order.push('sync');
    });
    try {
      const fetchFn = vi.fn(async () => {
        order.push('session');
        return json(sessionFixture());
      });
      const holder = createCsrfHolder();
      const api = createScanApi({ fetch: fetchFn as unknown as typeof fetch, csrf: holder.get });
      renderHook(() => useScanSession(api, holder, syncing(false)), { wrapper: wrapper() });
      await waitFor(() => expect(order).toContain('session'));
      expect(order[0]).toBe('sync');
    } finally {
      registerSync(null);
    }
  });

  it('is unpaired on SCANNER_UNAUTHENTICATED, and pair() loads the new session', async () => {
    let paired = false;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/pair')) {
        paired = true;
        return json(sessionFixture());
      }
      return paired
        ? json(sessionFixture())
        : json({ code: 'SCANNER_UNAUTHENTICATED', title: 'No', status: 401 }, 401);
    });
    const holder = createCsrfHolder();
    const api = createScanApi({ fetch: fetchFn as unknown as typeof fetch, csrf: holder.get });
    const { result } = renderHook(() => useScanSession(api, holder), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.phase).toBe('unpaired'));
    await act(async () => {
      await result.current.pair('ABCD-EFGH-JKLM');
    });
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.session?.scanner?.name).toBe('Front door');
  });

  it.each(['SCANNER_UNAUTHENTICATED', 'IDP_SIGN_IN_REQUIRED'])(
    'shows pairing, not "Scanner unavailable", on %s (a holder email session in the browser)',
    async (code) => {
      const fetchFn = vi.fn(async () => json({ code, title: 'No', status: 401 }, 401));
      const holder = createCsrfHolder();
      const api = createScanApi({ fetch: fetchFn as unknown as typeof fetch, csrf: holder.get });
      const { result } = renderHook(() => useScanSession(api, holder), { wrapper: wrapper() });
      await waitFor(() => expect(result.current.phase).toBe('unpaired'));
    },
  );

  it('a revoked scanner is a block, not an unpaired card', async () => {
    const fetchFn = vi.fn(async () =>
      json({ code: 'SCANNER_REVOKED', title: 'Gone', status: 401 }, 401),
    );
    const holder = createCsrfHolder();
    const api = createScanApi({ fetch: fetchFn as unknown as typeof fetch, csrf: holder.get });
    const { result } = renderHook(() => useScanSession(api, holder), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.phase).toBe('blocked'));
    expect(result.current.block).toBe('revoked');
  });
});

describe('needsSessionRefetch (configRev)', () => {
  const session = sessionFixture();
  const changed = { ...session.counts, configRev: session.counts.configRev + 1 };

  it('refetches between scans when the counts carry a different configRev', () => {
    expect(needsSessionRefetch(session, fixtureState({ counts: changed }))).toBe(true);
    expect(needsSessionRefetch(session, fixtureState({ counts: session.counts }))).toBe(false);
  });

  it('never under an open card, a drawer or a request', () => {
    expect(needsSessionRefetch(session, { ...states.member(), counts: changed })).toBe(false);
    expect(needsSessionRefetch(session, { ...states.checking(), counts: changed })).toBe(false);
    expect(needsSessionRefetch(session, fixtureState({ counts: changed, overlay: 'lookup' }))).toBe(
      false,
    );
    expect(needsSessionRefetch(session, { ...states.verdict('ok'), counts: changed })).toBe(false);
  });
});
