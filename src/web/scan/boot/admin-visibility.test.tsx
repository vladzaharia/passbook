import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgMembership } from '../../../shared/contracts/org-membership.ts';
import { managedSession } from '../../admin/scanning/sessions/test-fixtures.ts';
import { CoreProviders } from '../../lib/core-providers.tsx';
import {
  json,
  problem,
  type SessionKind,
  sessionFixture,
  stubFetch,
} from '../../lib/test-utils.tsx';
import { ScanApp } from '../scan-app.tsx';

const manager: OrgMembership = {
  id: 'membership-o1',
  orgId: 'o1',
  orgName: 'Northwind',
  orgSlug: 'northwind',
  userId: 'u1',
  roles: ['org_admin'],
  capabilities: ['scanning:read', 'scanning:manage'],
  createdAt: 1,
  revokedAt: null,
};

const membershipKey = ['scan', 'admin-orgs', 'u1'] as const;
type FetchMock = { mock: { calls: [RequestInfo | URL, RequestInit?][] } };

function requests(fetch: FetchMock, path: string) {
  return fetch.mock.calls.filter(
    ([input]) => new URL(String(input), 'http://localhost').pathname === path,
  );
}

function expectNoGlobalOrgs(fetch: FetchMock) {
  expect(requests(fetch, '/api/v1/orgs')).toHaveLength(0);
}

function expectNoSessionRequests(fetch: FetchMock) {
  expect(
    fetch.mock.calls.filter(([input]) =>
      new URL(String(input), 'http://localhost').pathname.startsWith('/api/v1/scanning-sessions'),
    ),
  ).toHaveLength(0);
}

function expectNoAdminEntry(fetch: FetchMock) {
  expect(screen.queryByRole('button', { name: 'Scan as Admin' })).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /^(Join session|Create and join)$/ }),
  ).not.toBeInTheDocument();
  expectNoSessionRequests(fetch);
  expectNoGlobalOrgs(fetch);
}

function deferredResponse() {
  // The web build targets ES2023; the test runtime provides withResolvers.
  const deferred = Promise as PromiseConstructor & {
    withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
  };
  return deferred.withResolvers<Response>();
}

function setup({
  role = 'user',
  memberships = [],
  path = '/scan',
  membershipResponse,
  cachedMemberships,
}: {
  role?: SessionKind;
  memberships?: OrgMembership[];
  path?: string;
  membershipResponse?: () => Response | Promise<Response>;
  cachedMemberships?: OrgMembership[];
} = {}) {
  history.replaceState(null, '', path);
  let identity = sessionFixture(role);
  let respondToMemberships = membershipResponse ?? (() => json({ items: memberships }));
  const fetch = stubFetch({
    '/api/v1/session': () => json(identity),
    '/api/v1/scan/session': () => problem(401, 'SCANNER_UNAUTHENTICATED', 'Pair this scanner.'),
    '/api/v1/orgs/memberships/me': () => respondToMemberships(),
    '/api/v1/scanning-sessions': () => json({ items: [managedSession], nextCursor: null }),
    '/api/v1/scanning-sessions/session-1': () => json(managedSession),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: cachedMemberships ? Infinity : 0 } },
  });
  if (cachedMemberships) {
    client.setQueryData(membershipKey, { items: cachedMemberships }, { updatedAt: 1 });
  }
  render(
    <CoreProviders queryClient={client}>
      <ScanApp />
    </CoreProviders>,
  );
  return {
    client,
    fetch,
    signOut: () => {
      identity = sessionFixture('anon');
    },
    setMembershipResponse: (response: () => Response | Promise<Response>) => {
      respondToMemberships = response;
    },
  };
}

async function expectBootScreen() {
  await waitFor(() =>
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('Loading scanner…'),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

describe('admin scanner entry', () => {
  const denied = [
    { label: 'anonymous user', role: 'anon', memberships: [] },
    { label: 'user without membership', role: 'user', memberships: [] },
    { label: 'platform admin without membership', role: 'admin', memberships: [] },
    {
      label: 'read-only member',
      role: 'user',
      memberships: [{ ...manager, roles: ['read_only'], capabilities: ['scanning:read'] }],
    },
    {
      label: 'org admin without scanning management',
      role: 'user',
      memberships: [{ ...manager, capabilities: ['scanning:read'] }],
    },
    {
      label: 'revoked manager',
      role: 'admin',
      memberships: [{ ...manager, revokedAt: 2 }],
    },
    {
      label: 'another user’s manager membership',
      role: 'admin',
      memberships: [{ ...manager, userId: 'u2' }],
    },
    {
      label: 'no single membership with all required attributes',
      role: 'user',
      memberships: [
        { ...manager, userId: 'u2' },
        {
          ...manager,
          id: 'membership-o2',
          orgId: 'o2',
          orgName: 'Southwind',
          orgSlug: 'southwind',
          roles: ['read_only'],
          capabilities: ['scanning:read'],
        },
        {
          ...manager,
          id: 'membership-o3',
          orgId: 'o3',
          orgName: 'Westwind',
          orgSlug: 'westwind',
          revokedAt: 2,
        },
      ],
    },
  ] satisfies { label: string; role: SessionKind; memberships: OrgMembership[] }[];

  it.each(denied.flatMap((scenario) => [false, true].map((direct) => ({ ...scenario, direct }))))(
    'denies $label on the pair screen and direct entry (direct=$direct)',
    async ({ role, memberships, direct }) => {
      const s = setup({
        role,
        memberships,
        path: direct ? '/scan?admin=1&orgId=o1&sessionId=session-1' : '/scan',
      });
      await waitFor(() =>
        expect(s.client.getQueryState(['scan', 'platform-session'])?.status).toBe('success'),
      );
      if (role !== 'anon') {
        await waitFor(() => expect(s.client.getQueryState(membershipKey)?.status).toBe('success'));
        expect(requests(s.fetch, '/api/v1/orgs/memberships/me').length).toBeGreaterThan(0);
      }
      await expectBootScreen();
      if (!direct) await screen.findByTestId('scan-pair');
      expectNoAdminEntry(s.fetch);
    },
  );

  it.each(['user', 'admin'] as const)(
    'lets an eligible %s open AdminStart but requires an explicit organization choice',
    async (role) => {
      const user = userEvent.setup();
      const s = setup({
        role,
        memberships: [manager],
        path: '/scan?orgId=o1&sessionId=session-1',
      });
      await user.click(await screen.findByRole('button', { name: 'Scan as Admin' }));
      await screen.findByRole('heading', { name: 'Scan as Admin' });
      const org = await screen.findByRole('combobox', { name: /Organization/ });
      await waitFor(() => expect(org).toBeEnabled());
      expect(org).toHaveTextContent('Choose an organization');
      expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
      expectNoSessionRequests(s.fetch);

      await user.click(org);
      await user.click(await screen.findByRole('option', { name: 'Northwind' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled(),
      );
      const list = requests(s.fetch, '/api/v1/scanning-sessions');
      expect(list.length).toBeGreaterThan(0);
      expect(new URL(String(list[0]?.[0]), 'http://localhost').searchParams.get('orgId')).toBe(
        'o1',
      );
      expect(requests(s.fetch, '/api/v1/scanning-sessions/join')).toHaveLength(0);
      expect(requests(s.fetch, '/api/v1/orgs/memberships/me').length).toBeGreaterThan(0);
      expectNoGlobalOrgs(s.fetch);
    },
  );

  it('requires an organization choice for an eligible direct link with session hints', async () => {
    const s = setup({
      memberships: [manager],
      path: '/scan?admin=1&orgId=o1&sessionId=session-1',
    });
    await screen.findByRole('heading', { name: 'Scan as Admin' });
    const org = await screen.findByRole('combobox', { name: /Organization/ });
    await waitFor(() => expect(org).toBeEnabled());
    expect(org).toHaveTextContent('Choose an organization');
    expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
    expectNoSessionRequests(s.fetch);
    expect(requests(s.fetch, '/api/v1/orgs/memberships/me').length).toBeGreaterThan(0);
    expectNoGlobalOrgs(s.fetch);
  });

  it.each([false, true])(
    'keeps entry unavailable while memberships load or fail (direct=%s)',
    async (direct) => {
      const response = deferredResponse();
      const s = setup({
        path: direct ? '/scan?admin=1' : '/scan',
        membershipResponse: () => response.promise,
      });
      await waitFor(() =>
        expect(s.client.getQueryState(membershipKey)?.fetchStatus).toBe('fetching'),
      );
      await expectBootScreen();
      expectNoAdminEntry(s.fetch);

      await act(async () => {
        response.resolve(problem(500, 'SERVER_ERROR', 'Failed to load memberships.'));
        await response.promise;
      });
      await waitFor(() => expect(s.client.getQueryState(membershipKey)?.status).toBe('error'));
      await expectBootScreen();
      expectNoAdminEntry(s.fetch);
    },
  );

  it('does not trust a stale cached membership while a fresh request is pending or after it returns empty', async () => {
    const response = deferredResponse();
    const s = setup({
      cachedMemberships: [manager],
      membershipResponse: () => response.promise,
    });
    await waitFor(() =>
      expect(s.client.getQueryState(membershipKey)?.fetchStatus).toBe('fetching'),
    );
    expect(s.client.getQueryData(membershipKey)).toEqual({ items: [manager] });
    await screen.findByTestId('scan-pair');
    expectNoAdminEntry(s.fetch);

    await act(async () => {
      response.resolve(json({ items: [] }));
      await response.promise;
    });
    await waitFor(() => expect(s.client.getQueryData(membershipKey)).toEqual({ items: [] }));
    expectNoAdminEntry(s.fetch);
  });

  it.each([
    { label: 'revoked', response: () => json({ items: [{ ...manager, revokedAt: 2 }] }) },
    {
      label: 'a failed refresh',
      response: () => problem(500, 'SERVER_ERROR', 'Failed to load memberships.'),
    },
  ])('hides cached access during refetch and after $label', async ({ response }) => {
    const pending = deferredResponse();
    const s = setup({ memberships: [manager] });
    await screen.findByRole('button', { name: 'Scan as Admin' });
    s.setMembershipResponse(() => pending.promise);
    let refreshing: Promise<void> = Promise.resolve();
    act(() => {
      refreshing = s.client.invalidateQueries({ queryKey: ['scan', 'admin-orgs'] });
    });
    await waitFor(() =>
      expect(s.client.getQueryState(membershipKey)?.fetchStatus).toBe('fetching'),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Scan as Admin' })).not.toBeInTheDocument(),
    );
    expectNoAdminEntry(s.fetch);

    await act(async () => {
      pending.resolve(response());
      await refreshing;
    });
    expect(requests(s.fetch, '/api/v1/orgs/memberships/me').length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expectNoAdminEntry(s.fetch));
  });

  it('removes the launcher and AdminStart when the platform user signs out', async () => {
    const user = userEvent.setup();
    const s = setup({ memberships: [manager] });
    await user.click(await screen.findByRole('button', { name: 'Scan as Admin' }));
    await screen.findByRole('heading', { name: 'Scan as Admin' });
    s.signOut();
    await act(async () => {
      await s.client.invalidateQueries({ queryKey: ['scan', 'platform-session'] });
    });
    await screen.findByTestId('scan-pair');
    expect(screen.queryByRole('heading', { name: 'Scan as Admin' })).not.toBeInTheDocument();
    expectNoAdminEntry(s.fetch);
    expect(requests(s.fetch, '/api/v1/session').length).toBeGreaterThanOrEqual(2);
  });
});
