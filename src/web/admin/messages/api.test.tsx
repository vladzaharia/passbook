import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/query-client.ts';
import { useBroadcastActions, useBroadcastPages } from './api.ts';
import { broadcast } from './test-fixtures.ts';

const { selected } = vi.hoisted(() => ({
  selected: {
    current: {
      orgId: undefined as string | undefined,
      isLoading: false,
      isError: false,
      membership: undefined as { capabilities: string[] } | undefined,
    },
  },
}));

vi.mock('../../lib/org-filter.tsx', () => ({ useOrgScope: () => selected.current }));

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function harness(respond: (url: URL) => Response | Promise<Response>) {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    respond(new URL(String(input), 'http://localhost')),
  );
  vi.stubGlobal('fetch', fetchMock);
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, fetchMock, wrapper: Wrapper };
}

beforeEach(() => {
  selected.current = { orgId: undefined, isLoading: false, isError: false, membership: undefined };
});
afterEach(() => vi.unstubAllGlobals());

describe('broadcast list scope', () => {
  it.each([
    {
      reason: 'no selection',
      selectedOrg: undefined,
      requestedOrg: 'o1',
      read: true,
      loading: false,
      error: false,
    },
    {
      reason: 'no requested organization',
      selectedOrg: 'o1',
      requestedOrg: undefined,
      read: true,
      loading: false,
      error: false,
    },
    {
      reason: 'a different organization',
      selectedOrg: 'o1',
      requestedOrg: 'o2',
      read: true,
      loading: false,
      error: false,
    },
    {
      reason: 'missing read capability',
      selectedOrg: 'o1',
      requestedOrg: 'o1',
      read: false,
      loading: false,
      error: false,
    },
    {
      reason: 'membership loading',
      selectedOrg: 'o1',
      requestedOrg: 'o1',
      read: true,
      loading: true,
      error: false,
    },
    {
      reason: 'membership failure',
      selectedOrg: 'o1',
      requestedOrg: 'o1',
      read: true,
      loading: false,
      error: true,
    },
  ])('does not request or expose a list with $reason', async (scenario) => {
    selected.current = {
      orgId: scenario.selectedOrg,
      isLoading: scenario.loading,
      isError: scenario.error,
      membership: scenario.selectedOrg
        ? { capabilities: scenario.read ? ['messages:read'] : ['passes:read'] }
        : undefined,
    };
    const { client, fetchMock, wrapper } = harness(() => json({ items: [], nextCursor: null }));
    const { result } = renderHook(
      () => useBroadcastPages({ orgId: scenario.requestedOrg, state: 'draft' }),
      { wrapper },
    );
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe('idle');
    await act(async () => {
      await result.current.refetch();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([['admin', 'broadcasts', 'pages', null]]);
  });

  it('drops previous rows immediately when the selected organization changes', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const other = deferred.withResolvers<Response>();
    selected.current = {
      orgId: 'o1',
      isLoading: false,
      isError: false,
      membership: { capabilities: ['messages:read'] },
    };
    const { fetchMock, wrapper } = harness((url) =>
      url.searchParams.get('orgId') === 'o2'
        ? other.promise
        : json({ items: [broadcast({ name: 'First organization' })], nextCursor: null }),
    );
    const { result, rerender } = renderHook(
      ({ orgId }: { orgId: string }) => useBroadcastPages({ orgId }),
      { wrapper, initialProps: { orgId: 'o1' } },
    );
    await waitFor(() =>
      expect(result.current.data?.pages[0]?.items[0]?.name).toBe('First organization'),
    );
    selected.current = {
      orgId: 'o2',
      isLoading: false,
      isError: false,
      membership: { capabilities: ['messages:read'] },
    };
    rerender({ orgId: 'o2' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
    await act(async () => {
      other.resolve(
        json({
          items: [broadcast({ id: 'b2', orgId: 'o2', name: 'Second organization' })],
          nextCursor: null,
        }),
      );
      await other.promise;
    });
    await waitFor(() =>
      expect(result.current.data?.pages[0]?.items[0]?.name).toBe('Second organization'),
    );
    expect(
      fetchMock.mock.calls.map(([input]) =>
        new URL(String(input), 'http://localhost').searchParams.get('orgId'),
      ),
    ).toEqual(['o1', 'o2']);
  });

  it('drops cached rows and refuses refetch when read permission is removed', async () => {
    selected.current = {
      orgId: 'o1',
      isLoading: false,
      isError: false,
      membership: { capabilities: ['messages:read'] },
    };
    const { fetchMock, wrapper } = harness(() =>
      json({ items: [broadcast({ name: 'Visible message' })], nextCursor: null }),
    );
    const { result, rerender } = renderHook(() => useBroadcastPages({ orgId: 'o1' }), { wrapper });
    await waitFor(() =>
      expect(result.current.data?.pages[0]?.items[0]?.name).toBe('Visible message'),
    );
    selected.current = {
      orgId: 'o1',
      isLoading: false,
      isError: false,
      membership: { capabilities: ['passes:read'] },
    };
    rerender();
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
    await act(async () => {
      await result.current.refetch();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains same-organization results while a new filter loads', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const failed = deferred.withResolvers<Response>();
    selected.current = {
      orgId: 'o1',
      isLoading: false,
      isError: false,
      membership: { capabilities: ['messages:read'] },
    };
    const { fetchMock, wrapper } = harness((url) =>
      url.searchParams.get('state') === 'failed'
        ? failed.promise
        : json({ items: [broadcast({ state: 'draft', name: 'Draft message' })], nextCursor: null }),
    );
    const { result, rerender } = renderHook(
      ({ state }: { state: 'draft' | 'failed' }) => useBroadcastPages({ orgId: 'o1', state }),
      { wrapper, initialProps: { state: 'draft' as 'draft' | 'failed' } },
    );
    await waitFor(() =>
      expect(result.current.data?.pages[0]?.items[0]?.name).toBe('Draft message'),
    );
    rerender({ state: 'failed' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.pages[0]?.items[0]?.name).toBe('Draft message');
    await act(async () => {
      failed.resolve(
        json({ items: [broadcast({ state: 'failed', name: 'Failed message' })], nextCursor: null }),
      );
      await failed.promise;
    });
    await waitFor(() =>
      expect(result.current.data?.pages[0]?.items[0]?.name).toBe('Failed message'),
    );
  });

  it('keeps the selected organization and cursor on subsequent pages', async () => {
    selected.current = {
      orgId: 'o1',
      isLoading: false,
      isError: false,
      membership: { capabilities: ['messages:read'] },
    };
    const seen: { orgId: string | null; cursor: string | null }[] = [];
    const { wrapper } = harness((url) => {
      const cursor = url.searchParams.get('cursor');
      seen.push({ orgId: url.searchParams.get('orgId'), cursor });
      return json({
        items: [broadcast({ id: cursor ? 'b2' : 'b1' })],
        nextCursor: cursor ? null : 'next-page',
      });
    });
    const { result } = renderHook(() => useBroadcastPages({ orgId: 'o1' }), { wrapper });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    // Observers are notified on a timer, after the fetch promise settles.
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(seen).toEqual([
      { orgId: 'o1', cursor: null },
      { orgId: 'o1', cursor: 'next-page' },
    ]);
  });
});

describe('broadcast mutation isolation', () => {
  it('does not publish a previous principal’s mutation result into the next session', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const pending = deferred.withResolvers<Response>();
    const { client, fetchMock, wrapper } = harness(() => pending.promise);
    const session = {
      authenticated: true,
      user: { id: 'u1', name: 'One', primaryEmail: 'one@example.com' },
      roles: ['user'],
      csrfToken: 'csrf-test',
      amr: 'oidc',
      expiresAt: 4_000_000_000_000,
    };
    client.setQueryData(['session'], session);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useBroadcastActions(), { wrapper });
    let mutation: Promise<unknown> | undefined;
    act(() => {
      mutation = result.current.send.mutateAsync({ id: 'b1' });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      client.setQueryData(['session'], { ...session, user: { ...session.user, id: 'u2' } });
      pending.resolve(json(broadcast({ state: 'sending' })));
      await mutation;
    });
    expect(client.getQueryData(['admin', 'broadcasts', 'detail', 'b1'])).toBeUndefined();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
