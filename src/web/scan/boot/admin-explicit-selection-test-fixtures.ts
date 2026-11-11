import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { expect, vi } from 'vitest';
import type { SessionResponse } from '../../../shared/contracts/session.ts';
import { managedSession } from '../../admin/scanning/sessions/test-fixtures.ts';
import { setCsrfProvider } from '../../lib/api.ts';
import { CoreProviders } from '../../lib/core-providers.tsx';
import { json, sessionFixture, stubFetch } from '../../lib/test-utils.tsx';
import { AdminStart } from './admin-start.tsx';

export type Membership = {
  id: string;
  orgId: string;
  orgName: string;
  orgSlug: string;
  userId: string;
  roles: string[];
  capabilities: string[];
  createdAt: number;
  revokedAt: number | null;
};

export function membership(orgId: string, orgName: string, manage = true): Membership {
  return {
    id: `membership-${orgId}`,
    orgId,
    orgName,
    orgSlug: orgName.toLowerCase().replaceAll(' ', '-'),
    userId: 'u1',
    roles: [manage ? 'org_admin' : 'read_only'],
    capabilities: manage ? ['scanning:read', 'scanning:manage'] : ['scanning:read'],
    createdAt: 1,
    revokedAt: null,
  };
}

export const southSession = {
  ...managedSession,
  id: 'session-2',
  orgId: 'o2',
  orgName: 'Southwind',
  name: 'South desk',
  devices: [],
};

export const joinedScope = { orgId: 'o1', setupId: 'device-1', mode: 'live', timeZone: 'UTC' };
type FetchMock = { mock: { calls: [RequestInfo | URL, RequestInit?][] } };

export function requests(fetch: FetchMock, path: string, method = 'GET') {
  return fetch.mock.calls.filter(
    ([input, init]) =>
      new URL(String(input), 'http://localhost').pathname === path &&
      (init?.method ?? 'GET') === method,
  );
}

export function sessionRequests(fetch: FetchMock) {
  return fetch.mock.calls.filter(([input]) =>
    new URL(String(input), 'http://localhost').pathname.startsWith('/api/v1/scanning-sessions'),
  );
}

export function expectNoGlobalOrgs(fetch: FetchMock) {
  expect(requests(fetch, '/api/v1/orgs/memberships/me').length).toBeGreaterThan(0);
  expect(
    fetch.mock.calls.some(
      ([input]) => new URL(String(input), 'http://localhost').pathname === '/api/v1/orgs',
    ),
  ).toBe(false);
}

export function expectStartUnavailable() {
  const action = screen.queryByRole('button', { name: /^(Join session|Create and join)$/ });
  if (action) expect(action).toBeDisabled();
}

export function setup({
  path = '/scan',
  memberships = [membership('o1', 'Northwind')],
  membershipResponse,
  lists = { o1: [managedSession], o2: [southSession] },
  identity = sessionFixture('user'),
  identityResponse,
  createdSession = managedSession,
  joined = joinedScope,
  joinResponse,
}: {
  path?: string;
  memberships?: Membership[];
  membershipResponse?: () => Response | Promise<Response>;
  lists?: Record<string, (typeof managedSession)[]>;
  identity?: SessionResponse;
  identityResponse?: () => Response | Promise<Response>;
  createdSession?: typeof managedSession;
  joined?: typeof joinedScope;
  joinResponse?: () => Response | Promise<Response>;
} = {}) {
  history.replaceState(null, '', path);
  // Verify the current identity's token, rather than a separately cached CSRF token.
  setCsrfProvider(async () => undefined);
  const fetch = stubFetch({
    '/api/v1/session': () => (identityResponse ? identityResponse() : json(identity)),
    '/api/v1/orgs/memberships/me': () =>
      membershipResponse ? membershipResponse() : json({ items: memberships }),
    '/api/v1/scanning-sessions': (url, init) => {
      if (init?.method === 'POST') return json(createdSession, 201);
      const orgId = url.searchParams.get('orgId') ?? '';
      return json({ items: lists[orgId] ?? [], nextCursor: null });
    },
    '/api/v1/scanning-sessions/session-1': () => json(managedSession),
    '/api/v1/scanning-sessions/session-2': () => json(southSession),
    '/api/v1/scanning-sessions/join': () => (joinResponse ? joinResponse() : json(joined)),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const onScope = vi.fn();
  const { rerender } = render(
    createElement(
      CoreProviders,
      { queryClient: client },
      createElement(AdminStart, { userId: 'u1', onScope }),
    ),
  );
  return { client, fetch, onScope, rerender };
}

export async function chooseOrg(name = 'Northwind') {
  const user = userEvent.setup();
  const select = await screen.findByRole('combobox', { name: /Organization/ });
  await waitFor(() => expect(select).toBeEnabled());
  await user.click(select);
  await user.click(await screen.findByRole('option', { name }));
  return user;
}

export function expectCsrf(init: RequestInit | undefined) {
  expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-test');
}

export function cleanupExplicitSelection() {
  vi.unstubAllGlobals();
  setCsrfProvider(async () => undefined);
  history.replaceState(null, '', '/');
}
