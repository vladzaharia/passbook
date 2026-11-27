import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { isRedirect } from '@tanstack/react-router';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgCapability, OrgMembership } from '@/shared/contracts/org-membership.ts';
import { ApiError } from './errors.ts';
import {
  canAccessAdminPath,
  isAdminPath,
  isPublicPath,
  requireAdminConsole,
  requireSession,
} from './guards.ts';
import { membershipsQuery, sessionQuery, useInvalidateSession } from './session.ts';
import {
  json,
  membershipFixture,
  problem,
  type SessionKind,
  sessionFixture,
  stubFetch,
} from './test-utils.tsx';

afterEach(() => vi.unstubAllGlobals());

function clientWith(kind: SessionKind, memberships: OrgMembership[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, sessionFixture(kind));
  client.setQueryData(membershipsQuery.queryKey, { items: memberships });
  return client;
}

describe('requireSession', () => {
  it('returns the session when signed in', async () => {
    const session = await requireSession(clientWith('user'), '/account');
    expect(session.user.id).toBe('u1');
  });

  it('redirects to /login with next when signed out', async () => {
    const error = await requireSession(clientWith('anon'), '/passes/1?x=2').catch(
      (e: unknown) => e,
    );
    expect(isRedirect(error)).toBe(true);
    expect((error as { options: { to: string; search: unknown } }).options).toMatchObject({
      to: '/login',
      search: { next: '/passes/1?x=2' },
    });
  });

  it('names the pass email on a signed-out pass link, and nothing on other pages', async () => {
    const pass = await requireSession(clientWith('anon'), '/passes/1').catch((e: unknown) => e);
    expect((pass as { options: { search: unknown } }).options.search).toEqual({
      next: '/passes/1',
      reason: 'pass',
    });
    const account = await requireSession(clientWith('anon'), '/account').catch((e: unknown) => e);
    expect((account as { options: { search: unknown } }).options.search).toEqual({
      next: '/account',
    });
  });

  it('drops an off-site next and home, so signing in picks the landing', async () => {
    for (const next of ['//evil.com', '/']) {
      const error = await requireSession(clientWith('anon'), next).catch((e: unknown) => e);
      expect((error as { options: { search: unknown } }).options.search).toEqual({});
    }
  });
});

describe('requireAdminConsole', () => {
  it('passes platform admins without memberships', async () => {
    await expect(requireAdminConsole(clientWith('admin'), '/admin')).resolves.toBeTruthy();
  });

  it('does not require a memberships request for platform console admission', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, sessionFixture('admin'));
    const fetchMock = stubFetch({});

    await expect(requireAdminConsole(client, '/admin/status')).resolves.toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes a signed-in member without a platform admin role', async () => {
    await expect(
      requireAdminConsole(clientWith('user', [membershipFixture('org-a')]), '/admin/passes'),
    ).resolves.toBeTruthy();
  });

  it('throws a 403 for a signed-in user without an active membership', async () => {
    for (const memberships of [[], [membershipFixture('org-a', { revokedAt: 123 })]]) {
      const error = await requireAdminConsole(clientWith('user', memberships), '/admin').catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 403, code: 'forbidden' });
    }
  });

  it('redirects signed-out users before checking roles', async () => {
    const error = await requireAdminConsole(clientWith('anon'), '/admin').catch((e: unknown) => e);
    expect(isRedirect(error)).toBe(true);
  });
});

describe('console admission cache authority', () => {
  it('rejects cached grants belonging to another principal, even alongside a matching grant', async () => {
    const client = clientWith('user', [
      membershipFixture('org-a'),
      membershipFixture('org-b', { userId: 'another-user' }),
    ]);
    await expect(requireAdminConsole(client, '/admin/passes')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('refreshes invalidated grants rather than admitting on stale cached membership', async () => {
    const client = clientWith('user', [membershipFixture('org-a')]);
    await client.invalidateQueries({
      queryKey: membershipsQuery.queryKey,
      exact: true,
      refetchType: 'none',
    });
    const fetchMock = stubFetch({
      '/api/v1/orgs/memberships/me': () => problem(503, 'unavailable', 'Unavailable'),
    });
    await expect(requireAdminConsole(client, '/admin/passes')).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('denies admission when a fresh membership response removes a cached grant', async () => {
    const client = clientWith('user', [membershipFixture('org-a')]);
    await client.invalidateQueries({
      queryKey: membershipsQuery.queryKey,
      exact: true,
      refetchType: 'none',
    });
    stubFetch({ '/api/v1/orgs/memberships/me': () => json({ items: [] }) });
    await expect(requireAdminConsole(client, '/admin/passes')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('does not admit from retained data after a failed membership refresh', async () => {
    const client = clientWith('user', [membershipFixture('org-a')]);
    const fetchMock = stubFetch({
      '/api/v1/orgs/memberships/me': () => problem(503, 'unavailable', 'Unavailable'),
    });
    await expect(client.fetchQuery({ ...membershipsQuery, staleTime: 0 })).rejects.toMatchObject({
      status: 503,
    });
    await expect(requireAdminConsole(client, '/admin/passes')).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('memberships authority', () => {
  it('loads the real memberships endpoint before admitting a non-admin member', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, sessionFixture('user'));
    const fetchMock = stubFetch({
      '/api/v1/orgs/memberships/me': () => json({ items: [membershipFixture('org-a')] }),
    });

    await expect(requireAdminConsole(client, '/admin/passes')).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/orgs/memberships/me');
    expect(client.getQueryData(membershipsQuery.queryKey)).toEqual({
      items: [membershipFixture('org-a')],
    });
  });

  it('propagates membership service failures instead of treating them as grants', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, sessionFixture('user'));
    stubFetch({
      '/api/v1/orgs/memberships/me': () => problem(503, 'unavailable', 'Unavailable'),
    });

    await expect(requireAdminConsole(client, '/admin/passes')).rejects.toMatchObject({
      status: 503,
    });
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

describe('canAccessAdminPath', () => {
  const member = membershipFixture('org-a');
  const reader = membershipFixture('org-a', {
    roles: ['read_only'],
    capabilities: [
      'org:read',
      'passes:read',
      'templates:read',
      'integrations:read',
      'scanning:read',
    ],
  });
  const o = (rest = '') => `/admin/o/org-a${rest}`;

  it('keeps platform pages to platform admins, with or without memberships', () => {
    for (const rest of ['', '/users', '/users/u1', '/orgs', '/orgs/o1', '/status', '/audit']) {
      const path = `/admin/platform${rest}`;
      expect(canAccessAdminPath(path, true), path).toBe(true);
      expect(canAccessAdminPath(path, false, member), path).toBe(false);
    }
    for (const rest of ['/wallet-accounts/i1', '/api-keys', '/settings']) {
      expect(canAccessAdminPath(`/admin/platform${rest}`, true)).toBe(true);
    }
    expect(canAccessAdminPath('/admin/account', false)).toBe(true);
    expect(canAccessAdminPath('/admin', false)).toBe(true);
  });

  it('opens an organization only with an active membership in that organization', () => {
    for (const rest of ['', '/', '/audit', '/api-keys', '/settings', '/passes']) {
      expect(canAccessAdminPath(o(rest), false, member), rest).toBe(true);
      // Platform status is not a membership.
      expect(canAccessAdminPath(o(rest), true), rest).toBe(false);
      expect(canAccessAdminPath(o(rest), true, membershipFixture('org-b')), rest).toBe(false);
      expect(
        canAccessAdminPath(o(rest), false, membershipFixture('org-a', { revokedAt: 1 })),
        rest,
      ).toBe(false);
    }
  });

  it('gates the overview, the audit log, API keys and settings on their own capabilities', () => {
    const only = (...capabilities: OrgCapability[]) => membershipFixture('org-a', { capabilities });
    const allowed = (rest: string, m: OrgMembership) => canAccessAdminPath(o(rest), false, m);
    expect(allowed('', only('org:read', 'passes:read'))).toBe(true);
    expect(allowed('', only('org:read'))).toBe(false);
    expect(allowed('', only('passes:read'))).toBe(false);
    expect(allowed('/audit', only('audit:read'))).toBe(true);
    expect(allowed('/audit', only('org:read', 'passes:read', 'integrations:manage'))).toBe(false);
    expect(allowed('/api-keys', only('integrations:read'))).toBe(true);
    expect(allowed('/api-keys', only('org:read', 'passes:read', 'audit:read'))).toBe(false);
    expect(allowed('/settings', only('org:read'))).toBe(true);
    expect(allowed('/settings', only('members:manage'))).toBe(false);
    expect(allowed('/blueprints', only('templates:read'))).toBe(true);
    expect(allowed('/blueprints', only('passes:read'))).toBe(false);
  });

  it.each([
    ['/passes', 'passes:read'],
    ['/passes/p1', 'passes:read'],
    ['/passes/new', 'passes:operate'],
    ['/connections', 'integrations:read'],
    ['/connections/c1', 'integrations:read'],
    ['/connections/new', 'integrations:manage'],
    ['/scanning', 'scanning:read'],
    ['/scanning/events/e1', 'scanning:read'],
  ] as const)('requires the membership capability for %s', (rest, capability) => {
    const authorized = membershipFixture('org-a', { capabilities: [capability] });
    const denied = membershipFixture('org-a', { capabilities: [] });
    expect(canAccessAdminPath(o(rest), false, authorized)).toBe(true);
    expect(canAccessAdminPath(o(rest), true, denied)).toBe(false);
  });

  it('allows template management roles, not pass operators who can only read templates', () => {
    const operator = membershipFixture('org-a', {
      roles: ['pass_operator'],
      capabilities: ['passes:read', 'passes:operate', 'templates:read'],
    });
    const author = membershipFixture('org-a', {
      roles: ['template_author'],
      capabilities: ['templates:read', 'templates:author'],
    });
    const reviewer = membershipFixture('org-a', {
      roles: ['template_reviewer'],
      capabilities: ['templates:read', 'templates:review'],
    });
    const publisher = membershipFixture('org-a', {
      roles: ['template_publisher'],
      capabilities: ['templates:read', 'templates:publish'],
    });
    const authorWithoutRead = membershipFixture('org-a', { capabilities: ['templates:author'] });
    for (const path of [o('/templates'), o('/templates/t1')]) {
      expect(canAccessAdminPath(path, false, operator), path).toBe(false);
      expect(canAccessAdminPath(path, true, operator), path).toBe(false);
      for (const manager of [author, reviewer, publisher]) {
        expect(canAccessAdminPath(path, false, manager), path).toBe(true);
      }
    }
    for (const path of [o('/templates/upload'), o('/templates/new'), o('/templates/t1/design')]) {
      expect(canAccessAdminPath(path, false, author), path).toBe(true);
      expect(canAccessAdminPath(path, false, reviewer), path).toBe(false);
      expect(canAccessAdminPath(path, false, publisher), path).toBe(false);
      expect(canAccessAdminPath(path, false, authorWithoutRead), path).toBe(false);
    }
  });

  it('requires write capabilities for create and authoring routes', () => {
    for (const rest of [
      '/passes/new',
      '/templates/upload',
      '/templates/t1/design',
      '/connections/new',
    ]) {
      expect(canAccessAdminPath(o(rest), false, reader), rest).toBe(false);
      expect(canAccessAdminPath(o(rest), false, member), rest).toBe(true);
    }
  });

  it('decodes the organization id from the path exactly once', () => {
    const slashed = membershipFixture('north/west', { capabilities: ['org:read'] });
    expect(canAccessAdminPath('/admin/o/north%2Fwest/settings', false, slashed)).toBe(true);
    expect(canAccessAdminPath('/admin/o/north%252Fwest/settings', false, slashed)).toBe(false);
    expect(canAccessAdminPath('/admin/o/%E0%A4%A/settings', true, member)).toBe(false);
  });

  it('requires message capabilities rather than platform or pass authority', () => {
    const messageReader = membershipFixture('org-a', { capabilities: ['messages:read'] });
    const messageManager = membershipFixture('org-a', { capabilities: ['messages:manage'] });
    for (const admin of [false, true]) {
      for (const rest of ['/messages', '/messages/m1']) {
        expect(canAccessAdminPath(o(rest), admin, messageReader), rest).toBe(true);
        expect(canAccessAdminPath(o(rest), admin, reader), rest).toBe(false);
        expect(canAccessAdminPath(o(rest), admin), rest).toBe(false);
      }
      expect(canAccessAdminPath(o('/messages/new'), admin, messageReader)).toBe(false);
      expect(canAccessAdminPath(o('/messages/new'), admin, messageManager)).toBe(true);
    }
  });

  it('requires tenant pass read access for the test inbox', () => {
    for (const admin of [false, true]) {
      expect(canAccessAdminPath(o('/test-inbox'), admin, reader)).toBe(true);
      expect(canAccessAdminPath(o('/test-inbox'), admin)).toBe(false);
    }
  });

  it('does not accept lookalike, legacy or unknown paths', () => {
    expect(canAccessAdminPath('/administrator', true, member)).toBe(false);
    expect(canAccessAdminPath(o('/passes-extra'), true, member)).toBe(false);
    expect(canAccessAdminPath(o('/unknown'), true, member)).toBe(false);
    expect(canAccessAdminPath('/admin/passes', true, member)).toBe(false);
    expect(canAccessAdminPath('/admin/users', true)).toBe(false);
    expect(canAccessAdminPath('/admin/platformx', true)).toBe(false);
  });
});

describe('path helpers', () => {
  it('recognises admin and public paths exactly', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/o/o1/passes')).toBe(true);
    expect(isAdminPath('/administrator')).toBe(false);
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/login/x')).toBe(false);
    // /scan is its own document now; the SPA guard no longer lets it through.
    expect(isPublicPath('/scan')).toBe(false);
  });
});

describe('organization Members and Wallet accounts', () => {
  const member = (capabilities: OrgCapability[]) => membershipFixture('o1', { capabilities });
  it('opens Members only with members:manage', () => {
    expect(canAccessAdminPath('/admin/o/o1/members', false, member(['members:manage']))).toBe(true);
    expect(canAccessAdminPath('/admin/o/o1/members', false, member(['org:read']))).toBe(false);
  });
  it('opens Wallet accounts with org:read, as the server does', () => {
    expect(canAccessAdminPath('/admin/o/o1/wallet-accounts', false, member(['org:read']))).toBe(
      true,
    );
    expect(canAccessAdminPath('/admin/o/o1/wallet-accounts', false, member(['passes:read']))).toBe(
      false,
    );
  });
});

describe('the All scope', () => {
  const org = (id: string, overrides: Partial<OrgMembership> = {}) =>
    membershipFixture(id, overrides);
  const noPasses = org('c', { capabilities: ['org:read'] });
  const path = '/admin/all/passes';

  it('opens with passes:read in two or more organizations', () => {
    expect(canAccessAdminPath(path, false, undefined, [org('a'), org('b')])).toBe(true);
    expect(canAccessAdminPath(path, true, undefined, [org('a'), org('b'), noPasses])).toBe(true);
  });

  it('stays closed with one readable organization, none, or no memberships list', () => {
    expect(canAccessAdminPath(path, false, undefined, [org('a')])).toBe(false);
    expect(canAccessAdminPath(path, false, undefined, [org('a'), noPasses])).toBe(false);
    expect(canAccessAdminPath(path, false, undefined, [])).toBe(false);
    expect(canAccessAdminPath(path, true)).toBe(false);
  });

  it('does not count revoked, sandbox or duplicate memberships', () => {
    const two = [org('a'), org('b', { revokedAt: 1 })];
    expect(canAccessAdminPath(path, false, undefined, two)).toBe(false);
    expect(
      canAccessAdminPath(path, false, undefined, [org('a'), org('s', { testOnly: true })]),
    ).toBe(false);
    expect(canAccessAdminPath(path, false, undefined, [org('a'), org('a')])).toBe(false);
  });

  it('admits only the Passes path, platform status adds nothing', () => {
    const both = [org('a'), org('b')];
    for (const rest of ['', '/passes/p1', '/passes/new', '/templates', '/members']) {
      expect(canAccessAdminPath(`/admin/all${rest}`, true, undefined, both), rest).toBe(false);
    }
    expect(canAccessAdminPath('/admin/all/passes/', false, undefined, both)).toBe(true);
  });
});
