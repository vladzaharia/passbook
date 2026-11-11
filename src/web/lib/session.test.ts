import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { fetchPreview } from './preview-batch.ts';
import { leaveSignedOut, membershipsQuery, sessionQuery, useInvalidateSession } from './session.ts';
import {
  json,
  membershipFixture,
  type SessionKind,
  sessionFixture,
  stubFetch,
} from './test-utils.tsx';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.removeItem('wallet-signed-out');
  sessionStorage.removeItem('wallet-signed-out-next');
});

function clientWith(kind: SessionKind, memberships: OrgMembership[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, sessionFixture(kind));
  client.setQueryData(membershipsQuery.queryKey, { items: memberships });
  return client;
}

describe('session and membership scope', () => {
  it('loads memberships for the authenticated session and rejects another user’s grants', async () => {
    const client = clientWith('user');
    const membership = membershipFixture('org-a');
    let items = [membership];
    const fetchMock = stubFetch({
      '/api/v1/orgs/memberships/me': () => json({ items }),
    });

    await expect(client.fetchQuery({ ...membershipsQuery, staleTime: 0 })).resolves.toEqual({
      items: [membership],
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/orgs/memberships/me');

    items = [membership, membershipFixture('org-b', { userId: 'u2' })];
    await expect(client.fetchQuery({ ...membershipsQuery, staleTime: 0 })).rejects.toMatchObject({
      status: 409,
      code: 'session_changed',
    });
    expect(client.getQueryState(membershipsQuery.queryKey)?.status).toBe('error');
  });

  it('loads a missing session before requesting its memberships', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const membership = membershipFixture('org-a');
    const fetchMock = stubFetch({
      '/api/v1/session': () => json(sessionFixture('user')),
      '/api/v1/orgs/memberships/me': () => json({ items: [membership] }),
    });

    await expect(client.fetchQuery(membershipsQuery)).resolves.toEqual({ items: [membership] });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/v1/session',
      '/api/v1/orgs/memberships/me',
    ]);
  });

  it('loads the session before requesting grants and does not request them when signed out', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = stubFetch({
      '/api/v1/session': () => json(sessionFixture('anon')),
      '/api/v1/orgs/memberships/me': () => json({ items: [membershipFixture('org-a')] }),
    });

    await expect(client.fetchQuery(membershipsQuery)).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/v1/session']);
  });

  it('uses the retained session when its refresh failed', async () => {
    const client = clientWith('user');
    const session = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
    if (!session) throw new Error('Expected a cached session');
    session.setState({ status: 'error', error: new Error('Session refresh failed') });
    const fetchMock = stubFetch({ '/api/v1/orgs/memberships/me': () => json({ items: [] }) });

    await expect(client.fetchQuery({ ...membershipsQuery, staleTime: 0 })).resolves.toEqual({
      items: [],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps memberships when the session refresh fails while they are in flight', async () => {
    const client = clientWith('user');
    let resolveMembership!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveMembership = resolve;
    });
    const fetchMock = stubFetch({ '/api/v1/orgs/memberships/me': () => pending });
    const loaded = client.fetchQuery({ ...membershipsQuery, staleTime: 0 });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const session = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
    if (!session) throw new Error('Expected a cached session');
    session.setState({ status: 'error', error: new Error('Session refresh failed') });
    resolveMembership(json({ items: [membershipFixture('org-a')] }));
    await expect(loaded).resolves.toMatchObject({ items: [{ orgId: 'org-a' }] });
  });

  it('rejects a membership response if the cached principal changes while it is in flight', async () => {
    const client = clientWith('user');
    let resolveMembership!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveMembership = resolve;
    });
    const fetchMock = stubFetch({ '/api/v1/orgs/memberships/me': () => pending });
    const session = sessionFixture('user');
    if (!session.authenticated) throw new Error('Expected an authenticated fixture');
    const rejected = expect(
      client.fetchQuery({ ...membershipsQuery, staleTime: 0 }),
    ).rejects.toMatchObject({ status: 409, code: 'session_changed' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const updatedSession: typeof session = { ...session, user: { ...session.user, id: 'u2' } };
    client.setQueryData(sessionQuery.queryKey, updatedSession);
    resolveMembership(json({ items: [membershipFixture('org-a')] }));
    await rejected;
  });

  it('loads the new principal’s grants after a session switch evicts the old scope', async () => {
    const previousMembership = membershipFixture('org-a');
    const nextMembership = membershipFixture('org-b', { userId: 'u2' });
    const client = clientWith('user', [previousMembership]);
    const session = sessionFixture('user');
    if (!session.authenticated) throw new Error('Expected an authenticated fixture');
    stubFetch({
      '/api/v1/session': () => json({ ...session, user: { ...session.user, id: 'u2' } }),
      '/api/v1/orgs/memberships/me': () => json({ items: [nextMembership] }),
    });

    await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
    expect(client.getQueryData(membershipsQuery.queryKey)).toBeUndefined();
    await expect(client.fetchQuery(membershipsQuery)).resolves.toEqual({ items: [nextMembership] });
  });

  it('cancels queued template previews when the principal changes', async () => {
    vi.useFakeTimers();
    const client = clientWith('user');
    const session = sessionFixture('user');
    if (!session.authenticated) throw new Error('Expected an authenticated fixture');
    stubFetch({
      '/api/v1/session': () => json({ ...session, user: { ...session.user, id: 'u2' } }),
    });
    const rejected = expect(fetchPreview('template-a', 'org-a')).rejects.toMatchObject({
      name: 'AbortError',
    });

    await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
    await rejected;
  });

  it('cancels queued template previews before sign-out navigation', async () => {
    vi.useFakeTimers();
    const rejected = expect(fetchPreview('template-a', 'org-a')).rejects.toMatchObject({
      name: 'AbortError',
    });

    // jsdom cannot navigate; leaveSignedOut still runs its cleanup before attempting to leave.
    leaveSignedOut('/login');
    await rejected;
  });

  it('keeps cached memberships but marks them stale when the session is invalidated', async () => {
    const membership = membershipFixture('org-a');
    const client = clientWith('user', [membership]);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result, unmount } = renderHook(() => useInvalidateSession(), { wrapper });

    await result.current();
    expect(client.getQueryData(membershipsQuery.queryKey)).toEqual({ items: [membership] });
    expect(client.getQueryState(membershipsQuery.queryKey)?.isInvalidated).toBe(true);
    unmount();
  });

  it('retains active membership data throughout a same-user session invalidation', async () => {
    const membership = membershipFixture('org-a');
    const client = clientWith('user', [membership]);
    // The web test target is ES2023, before Promise.withResolvers.
    let resolveMembership!: (response: Response) => void;
    const pendingMembership = new Promise<Response>((resolve) => {
      resolveMembership = resolve;
    });
    const fetchMock = stubFetch({
      '/api/v1/session': () => json(sessionFixture('user')),
      '/api/v1/orgs/memberships/me': () => pendingMembership,
    });
    const membershipObserver = new QueryObserver(client, membershipsQuery);
    const sessionObserver = new QueryObserver(client, sessionQuery);
    const unsubscribeMembership = membershipObserver.subscribe(() => {});
    const unsubscribeSession = sessionObserver.subscribe(() => {});
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result, unmount } = renderHook(() => useInvalidateSession(), { wrapper });
    let invalidation!: Promise<void>;

    try {
      act(() => {
        invalidation = result.current();
      });
      await waitFor(() => expect(membershipObserver.getCurrentResult().isFetching).toBe(true));
      expect(membershipObserver.getCurrentResult()).toMatchObject({
        data: { items: [membership] },
        isLoading: false,
      });
      await act(async () => {
        resolveMembership(json({ items: [membership] }));
        await invalidation;
      });
      expect(membershipObserver.getCurrentResult().data).toEqual({ items: [membership] });
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url) === '/api/v1/orgs/memberships/me'),
      ).toHaveLength(1);
    } finally {
      resolveMembership(json({ items: [membership] }));
      unmount();
      unsubscribeSession();
      unsubscribeMembership();
    }
  });

  it('clears platform and tenant caches when the session changes user', async () => {
    const client = clientWith('user', [membershipFixture('org-a')]);
    client.setQueryData(['audit', 'list'], { items: ['old audit'] });
    client.setQueryData(['passes', 'list'], { items: ['old pass'] });
    client.setQueryData(['session', 'other'], { items: ['old session data'] });
    const mutation = client.getMutationCache().build(client, {
      mutationFn: async (email: string) => ({ email }),
    });
    await mutation.execute('old@example.com');
    const session = sessionFixture('user');
    if (!session.authenticated) throw new Error('Expected an authenticated fixture');
    stubFetch({
      '/api/v1/session': () => json({ ...session, user: { ...session.user, id: 'u2' } }),
    });

    await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
    expect(client.getQueryData(membershipsQuery.queryKey)).toBeUndefined();
    expect(client.getQueryData(['audit', 'list'])).toBeUndefined();
    expect(client.getQueryData(['passes', 'list'])).toBeUndefined();
    expect(client.getQueryData(['session', 'other'])).toBeUndefined();
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(client.getQueryData(sessionQuery.queryKey)).toMatchObject({
      authenticated: true,
      user: { id: 'u2' },
    });
  });

  it('drops pending mutation cache entries without cancelling the pending operation', async () => {
    const client = clientWith('user', [membershipFixture('org-a')]);
    // The web test target is ES2023, before Promise.withResolvers.
    let complete!: (result: string) => void;
    const pending = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const mutation = client.getMutationCache().build(client, {
      mutationFn: (_email: string) => pending,
    });
    const result = mutation.execute('private@example.com');
    const session = sessionFixture('user');
    if (!session.authenticated) throw new Error('Expected an authenticated fixture');
    stubFetch({
      '/api/v1/session': () => json({ ...session, user: { ...session.user, id: 'u2' } }),
    });

    try {
      await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
      expect(client.getMutationCache().getAll()).toHaveLength(0);
      complete('settled');
      await expect(result).resolves.toBe('settled');
      expect(client.getMutationCache().getAll()).toHaveLength(0);
    } finally {
      complete('settled');
    }
  });

  it.each([
    ['anon', 'user'],
    ['user', 'anon'],
  ] as const)(
    'clears other caches when authentication changes from %s to %s',
    async (before, after) => {
      const client = clientWith(before, [membershipFixture('org-a')]);
      client.setQueryData(['orgs', 'list'], { items: ['old organization'] });
      stubFetch({ '/api/v1/session': () => json(sessionFixture(after)) });

      await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
      expect(client.getQueryData(membershipsQuery.queryKey)).toBeUndefined();
      expect(client.getQueryData(['orgs', 'list'])).toBeUndefined();
    },
  );

  it('resets active resource observers before they can show a previous user’s data', async () => {
    const client = clientWith('user', [membershipFixture('org-a')]);
    client.setQueryData(['passes', 'list'], { items: ['old pass'] });
    // The web test target is ES2023, before Promise.withResolvers.
    let resolveFresh!: (value: { items: string[] }) => void;
    const fresh = new Promise<{ items: string[] }>((resolve) => {
      resolveFresh = resolve;
    });
    const observer = new QueryObserver(client, {
      queryKey: ['passes', 'list'],
      queryFn: () => fresh,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    const seededObserver = new QueryObserver(client, {
      queryKey: ['portal', 'pass'],
      queryFn: () => fresh,
      initialData: { items: ['old seeded pass'] },
      staleTime: Infinity,
    });
    const unsubscribeSeeded = seededObserver.subscribe(() => {});
    const session = sessionFixture('user');
    if (!session.authenticated) throw new Error('Expected an authenticated fixture');
    stubFetch({
      '/api/v1/session': () => json({ ...session, user: { ...session.user, id: 'u2' } }),
    });

    try {
      await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
      expect(observer.getCurrentResult().data).toBeUndefined();
      expect(seededObserver.getCurrentResult().data).toBeUndefined();
      expect(client.getQueryData(['portal', 'pass'])).toBeUndefined();
    } finally {
      resolveFresh({ items: ['new pass'] });
      unsubscribe();
      unsubscribeSeeded();
    }
  });

  it('invalidates memberships without clearing same-user cached data', async () => {
    const membership = membershipFixture('org-a');
    const client = clientWith('user', [membership]);
    client.setQueryData(['audit', 'list'], { items: ['same user audit'] });
    client.setQueryData(['passes', 'list'], { items: ['same user pass'] });
    const mutation = client.getMutationCache().build(client, {
      mutationFn: async (email: string) => ({ email }),
    });
    await mutation.execute('same@example.com');
    // The role can change while the authenticated user ID stays the same.
    stubFetch({ '/api/v1/session': () => json(sessionFixture('admin')) });

    await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
    expect(client.getQueryData(membershipsQuery.queryKey)).toEqual({ items: [membership] });
    expect(client.getQueryState(membershipsQuery.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryData(['audit', 'list'])).toEqual({ items: ['same user audit'] });
    expect(client.getQueryData(['passes', 'list'])).toEqual({ items: ['same user pass'] });
    expect(client.getMutationCache().getAll()).toContain(mutation);
  });
});
