import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgMembership } from '../../../shared/contracts/org-membership.ts';
import type { SessionResponse } from '../../../shared/contracts/session.ts';
import { managedSession } from '../../admin/scanning/sessions/test-fixtures.ts';
import { CoreProviders } from '../../lib/core-providers.tsx';
import { json, problem, sessionFixture, stubFetch } from '../../lib/test-utils.tsx';
import { AdminStart } from './admin-start.tsx';

const southSession = {
  ...managedSession,
  id: 'session-2',
  orgId: 'o2',
  orgName: 'Southwind',
  name: 'South desk',
  devices: [],
};

function membership(orgId: string, orgName: string, manage = true): OrgMembership {
  return {
    id: `membership-${orgId}`,
    orgId,
    orgName,
    orgSlug: orgName.toLowerCase(),
    userId: 'u1',
    roles: [manage ? 'org_admin' : 'read_only'],
    capabilities: manage ? ['scanning:read', 'scanning:manage'] : ['scanning:read'],
    createdAt: 1,
    revokedAt: null,
  };
}

function setup({
  memberships = [],
  path = '/scan',
  role = 'user',
  lists = {},
  selectedSession = managedSession,
  membershipResponse,
  identity = sessionFixture(role),
}: {
  memberships?: OrgMembership[];
  path?: string;
  role?: 'user' | 'admin';
  lists?: Record<string, (typeof managedSession)[]>;
  selectedSession?: typeof managedSession;
  identity?: SessionResponse;
  membershipResponse?: () => Response | Promise<Response>;
} = {}) {
  history.replaceState(null, '', path);
  const requests: string[] = [];
  const joins: { sessionId: string; deviceKey: string }[] = [];
  const onScope = vi.fn();
  const fetch = stubFetch({
    '/api/v1/session': () => json(identity),
    '/api/v1/orgs/memberships/me': () =>
      membershipResponse ? membershipResponse() : json({ items: memberships }),
    '/api/v1/scanning-sessions': (url) => {
      const orgId = url.searchParams.get('orgId') ?? '';
      requests.push(orgId);
      return json({
        items: lists[orgId] ?? (orgId === 'o1' ? [managedSession] : [southSession]),
        nextCursor: null,
      });
    },
    '/api/v1/scanning-sessions/session-1': () => json(selectedSession),
    '/api/v1/scanning-sessions/session-2': () => json(southSession),
    '/api/v1/scanning-sessions/join': (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { sessionId: string; deviceKey: string };
      joins.push(body);
      return json({
        orgId: body.sessionId === 'session-2' ? 'o2' : 'o1',
        setupId: 'device-1',
        mode: 'live',
        timeZone: 'UTC',
      });
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <CoreProviders queryClient={client}>
      <AdminStart userId="u1" onScope={onScope} />
    </CoreProviders>,
  );
  return { client, fetch, requests, joins, onScope };
}

function requestedPath(s: ReturnType<typeof setup>, path: string) {
  return s.fetch.mock.calls.some(
    ([url]) => new URL(String(url), location.origin).pathname === path,
  );
}

async function expectOrganizationChoice(s: ReturnType<typeof setup>) {
  await waitFor(() => expect(screen.getByRole('combobox', { name: /Organization/ })).toBeEnabled());
  expect(screen.getByRole('combobox', { name: /Organization/ })).toHaveTextContent(
    'Choose an organization',
  );
  expect(screen.queryByRole('combobox', { name: /Scanning session/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
  expect(s.requests).toEqual([]);
  expect(s.joins).toEqual([]);
  expect(s.fetch.mock.calls.some(([url]) => String(url).includes('/scanning-sessions'))).toBe(
    false,
  );
  expect(requestedPath(s, '/api/v1/orgs')).toBe(false);
  expect(requestedPath(s, '/api/v1/session')).toBe(false);
}

async function chooseOrganization(name: string, user = userEvent.setup()) {
  await user.click(screen.getByRole('combobox', { name: /Organization/ }));
  await user.click(screen.getByRole('option', { name }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

describe('scanner organization membership', () => {
  it.each([
    {
      label: 'read-only member',
      role: 'user' as const,
      memberships: [membership('o1', 'Northwind', false)],
    },
    { label: 'platform administrator without membership', role: 'admin' as const, memberships: [] },
    {
      label: 'revoked manager',
      role: 'admin' as const,
      memberships: [{ ...membership('o1', 'Northwind'), revokedAt: 2 }],
    },
    {
      label: 'another user’s membership',
      role: 'user' as const,
      memberships: [{ ...membership('o1', 'Northwind'), userId: 'u2' }],
    },
  ])('denies a $label even with a direct session link', async ({ role, memberships }) => {
    const s = setup({ role, memberships, path: '/scan?orgId=o1&sessionId=session-1' });
    await screen.findByText('No organizations grant you scanning management access.');
    expect(screen.queryByRole('combobox', { name: /Organization/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Join session|Create and join/ }),
    ).not.toBeInTheDocument();
    expect(s.requests).toEqual([]);
    expect(s.joins).toEqual([]);
    expect(s.fetch.mock.calls.some(([url]) => String(url).includes('/scanning-sessions'))).toBe(
      false,
    );
    expect(
      s.fetch.mock.calls.some(
        ([url]) => new URL(String(url), location.origin).pathname === '/api/v1/orgs',
      ),
    ).toBe(false);
    expect(requestedPath(s, '/api/v1/session')).toBe(false);
  });

  it.each([
    {
      label: 'a sole membership and no hint',
      memberships: [membership('o1', 'Northwind')],
      path: '/scan',
    },
    {
      label: 'a sole membership and a matching organization hint',
      memberships: [membership('o1', 'Northwind')],
      path: '/scan?orgId=o1',
    },
    {
      label: 'multiple memberships and no hint',
      memberships: [membership('o1', 'Northwind'), membership('o2', 'Southwind')],
      path: '/scan',
    },
    {
      label: 'multiple memberships and a matching organization hint',
      memberships: [membership('o1', 'Northwind'), membership('o2', 'Southwind')],
      path: '/scan?orgId=o1',
    },
    {
      label: 'a sole membership and an unknown organization hint',
      memberships: [membership('o1', 'Northwind')],
      path: '/scan?orgId=unknown',
    },
  ])('requires an explicit organization choice with $label', async ({ memberships, path }) => {
    const s = setup({ memberships, path });
    await expectOrganizationChoice(s);
    await chooseOrganization('Northwind');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    expect(s.requests).toEqual(['o1']);
    expect(requestedPath(s, '/api/v1/scanning-sessions/session-1')).toBe(false);
    expect(screen.getByRole('combobox', { name: /Scanning session/ })).toHaveTextContent(
      'Membership desk',
    );
  });

  it('does not select an organization when memberships are refreshed before a choice', async () => {
    const s = setup({
      memberships: [membership('o1', 'Northwind')],
      path: '/scan?orgId=o1&sessionId=session-1',
    });
    await expectOrganizationChoice(s);
    await s.client.invalidateQueries({ queryKey: ['scan', 'admin-orgs'] });
    await expectOrganizationChoice(s);
    expect(
      s.fetch.mock.calls.filter(
        ([url]) => new URL(String(url), location.origin).pathname === '/api/v1/orgs/memberships/me',
      ),
    ).toHaveLength(2);
    await chooseOrganization('Northwind');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    expect(s.requests).toEqual(['o1']);
    expect(requestedPath(s, '/api/v1/scanning-sessions/session-1')).toBe(true);
  });

  it('isolates organization choices, session lists and the joined scope across organizations', async () => {
    const s = setup({
      memberships: [
        membership('o1', 'Northwind'),
        membership('o2', 'Southwind'),
        membership('o3', 'Readonly', false),
      ],
      path: '/scan?orgId=o1&sessionId=session-1',
      lists: { o1: [managedSession, southSession], o2: [southSession, managedSession] },
    });
    await expectOrganizationChoice(s);
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /Organization/ }));
    expect(screen.getByRole('option', { name: 'Northwind' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Southwind' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Readonly' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Northwind' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    expect(s.requests).toEqual(['o1']);
    expect(requestedPath(s, '/api/v1/scanning-sessions/session-1')).toBe(true);
    await chooseOrganization('Southwind', user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    expect(s.requests).toEqual(['o1', 'o2']);
    await user.click(screen.getByRole('combobox', { name: /Scanning session/ }));
    expect(screen.getByRole('option', { name: 'South desk' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Membership desk' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'South desk' }));
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    await waitFor(() =>
      expect(s.onScope).toHaveBeenCalledWith({
        orgId: 'o2',
        setupId: 'device-1',
        mode: 'live',
        timeZone: 'UTC',
      }),
    );
    expect(s.joins).toEqual([{ sessionId: 'session-2', deviceKey: expect.any(String) }]);
    expect([...new Set(s.requests)]).toEqual(['o1', 'o2']);
  });

  it('does not follow an unauthorized deep link or silently replace it with another organization', async () => {
    const s = setup({
      memberships: [membership('o1', 'Northwind'), membership('o2', 'Southwind', false)],
      path: '/scan?orgId=o2&sessionId=session-2',
    });
    const user = userEvent.setup();
    await expectOrganizationChoice(s);
    expect(
      s.fetch.mock.calls.some(([url]) => String(url).includes('/scanning-sessions/session-2')),
    ).toBe(false);
    await chooseOrganization('Northwind', user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    expect(s.requests).toEqual(['o1']);
    expect(requestedPath(s, '/api/v1/scanning-sessions/session-2')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    await waitFor(() => expect(s.onScope).toHaveBeenCalledOnce());
    expect([...new Set(s.requests)]).toEqual(['o1']);
    expect(requestedPath(s, '/api/v1/scanning-sessions/session-2')).toBe(false);
    expect(s.joins[0]?.sessionId).toBe('session-1');
  });

  it('follows an authorized session hint only after its organization is chosen', async () => {
    const s = setup({
      memberships: [membership('o1', 'Northwind'), membership('o2', 'Southwind')],
      path: '/scan?orgId=o2&sessionId=session-2',
      lists: { o1: [managedSession], o2: [] },
    });
    const user = userEvent.setup();
    await expectOrganizationChoice(s);
    await chooseOrganization('Northwind', user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    expect(s.requests).toEqual(['o1']);
    expect(requestedPath(s, '/api/v1/scanning-sessions/session-2')).toBe(false);

    await chooseOrganization('Southwind', user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    expect(s.requests).toEqual(['o1', 'o2']);
    expect(requestedPath(s, '/api/v1/scanning-sessions/session-2')).toBe(true);
    expect(screen.getByRole('combobox', { name: /Scanning session/ })).toHaveTextContent(
      'South desk',
    );
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    await waitFor(() =>
      expect(s.onScope).toHaveBeenCalledWith({
        orgId: 'o2',
        setupId: 'device-1',
        mode: 'live',
        timeZone: 'UTC',
      }),
    );
    expect(s.joins).toEqual([{ sessionId: 'session-2', deviceKey: expect.any(String) }]);
    expect([...new Set(s.requests)]).toEqual(['o1', 'o2']);
  });

  it('joins an authorized linked session outside the first list page', async () => {
    const s = setup({
      memberships: [membership('o1', 'Northwind')],
      path: '/scan?orgId=o1&sessionId=session-1',
      lists: { o1: [] },
    });
    await expectOrganizationChoice(s);
    await chooseOrganization('Northwind');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    expect(screen.getByRole('combobox', { name: /Scanning session/ })).toHaveTextContent(
      'Membership desk',
    );
    expect(s.requests).toEqual(['o1']);
    expect(requestedPath(s, '/api/v1/scanning-sessions/session-1')).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Join session' }));
    await waitFor(() => expect(s.onScope).toHaveBeenCalledOnce());
    expect(s.joins[0]?.sessionId).toBe('session-1');
  });

  it('honors a session-only link after an explicit organization choice', async () => {
    const s = setup({
      memberships: [membership('o1', 'Northwind')],
      path: '/scan?sessionId=session-1',
      lists: { o1: [] },
    });
    await expectOrganizationChoice(s);
    await chooseOrganization('Northwind');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    expect(s.requests).toEqual(['o1']);
    expect(requestedPath(s, '/api/v1/scanning-sessions/session-1')).toBe(true);
    expect(screen.getByRole('combobox', { name: /Scanning session/ })).toHaveTextContent(
      'Membership desk',
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Join session' }));
    await waitFor(() => expect(s.onScope).toHaveBeenCalledOnce());
    expect(s.joins[0]?.sessionId).toBe('session-1');
  });

  it('does not join or create a session for an invalid session hint', async () => {
    const s = setup({
      memberships: [membership('o1', 'Northwind')],
      path: '/scan?orgId=o1&sessionId=missing',
    });
    await expectOrganizationChoice(s);
    await chooseOrganization('Northwind');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(requestedPath(s, '/api/v1/scanning-sessions/missing')).toBe(true);
    expect(s.requests).toEqual(['o1']);
    expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Create and join' })).not.toBeInTheDocument();
    expect(s.joins).toEqual([]);
    expect(s.onScope).not.toHaveBeenCalled();
  });

  it('can create a session when an authorized linked session is no longer active', async () => {
    const s = setup({
      memberships: [membership('o1', 'Northwind')],
      path: '/scan?orgId=o1&sessionId=session-1',
      lists: { o1: [] },
      selectedSession: { ...managedSession, status: 'paused' },
    });
    await expectOrganizationChoice(s);
    await chooseOrganization('Northwind');
    expect(await screen.findByRole('textbox', { name: 'New session name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and join' })).toBeEnabled();
  });

  it('does not start after the signed-in account changes', async () => {
    const identity = sessionFixture('user');
    if (!identity.authenticated) throw new Error('Expected a signed-in fixture.');
    const s = setup({
      memberships: [membership('o1', 'Northwind')],
      identity: { ...identity, user: { ...identity.user, id: 'u2' } },
    });
    await expectOrganizationChoice(s);
    await chooseOrganization('Northwind');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Join session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your sign-in changed. Reopen the scanner and try again.',
    );
    expect(s.joins).toEqual([]);
    expect(s.onScope).not.toHaveBeenCalled();
    expect(
      s.fetch.mock.calls.filter(
        ([url]) => new URL(String(url), location.origin).pathname === '/api/v1/orgs/memberships/me',
      ),
    ).toHaveLength(1);
  });

  it('does not join a selected session from another organization', async () => {
    const s = setup({
      memberships: [membership('o1', 'Northwind'), membership('o2', 'Southwind')],
      path: '/scan?orgId=o1&sessionId=session-2',
    });
    const user = userEvent.setup();
    await expectOrganizationChoice(s);
    await chooseOrganization('Northwind', user);
    await waitFor(() => expect(s.requests).toEqual(['o1']));
    await waitFor(() => expect(requestedPath(s, '/api/v1/scanning-sessions/session-2')).toBe(true));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /Scanning session/ })).toHaveTextContent(
        'Choose a session',
      ),
    );
    expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
    expect(s.joins).toEqual([]);
    expect(s.onScope).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('combobox', { name: /Scanning session/ }));
    expect(await screen.findByRole('option', { name: 'Membership desk' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'South desk' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Membership desk' }));
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    await waitFor(() => expect(s.onScope).toHaveBeenCalledOnce());
    expect(s.joins[0]?.sessionId).toBe('session-1');
  });

  it('waits for a fresh membership check before joining', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const response = deferred.withResolvers<Response>();
    let calls = 0;
    const s = setup({
      membershipResponse: () =>
        calls++ === 0 ? json({ items: [membership('o1', 'Northwind')] }) : response.promise,
    });
    const user = userEvent.setup();
    await expectOrganizationChoice(s);
    await chooseOrganization('Northwind', user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /Organization/ })).toBeDisabled(),
    );
    for (const action of screen.queryAllByRole('button', {
      name: /Join session|Create and join/,
    })) {
      expect(action).toBeDisabled();
      expect(action).toHaveAttribute('aria-busy', 'true');
    }
    expect(s.joins).toEqual([]);
    expect(s.onScope).not.toHaveBeenCalled();
    response.resolve(json({ items: [membership('o1', 'Northwind')] }));
    await waitFor(() => expect(s.onScope).toHaveBeenCalledOnce());
    expect(s.joins).toEqual([{ sessionId: 'session-1', deviceKey: expect.any(String) }]);
    expect([...new Set(s.requests)]).toEqual(['o1']);
  });

  it.each([
    { label: 'removed', refreshed: () => json({ items: [] }) },
    {
      label: 'revoked',
      refreshed: () => json({ items: [{ ...membership('o1', 'Northwind'), revokedAt: 2 }] }),
    },
    {
      label: 'downgraded to read-only',
      refreshed: () => json({ items: [membership('o1', 'Northwind', false)] }),
    },
    {
      label: 'assigned to another user',
      refreshed: () => json({ items: [{ ...membership('o1', 'Northwind'), userId: 'u2' }] }),
    },
    {
      label: 'replaced by a different membership for the same organization',
      refreshed: () =>
        json({ items: [{ ...membership('o1', 'Northwind'), id: 'replacement-membership' }] }),
    },
    {
      label: 'replaced by another organization',
      refreshed: () => json({ items: [membership('o2', 'Southwind')] }),
    },
    {
      label: 'unavailable during refresh',
      refreshed: () => problem(500, 'SERVER_ERROR', 'Failed to load memberships.'),
    },
  ])('does not start when selected access is $label', async ({ refreshed }) => {
    let calls = 0;
    const s = setup({
      membershipResponse: () =>
        calls++ === 0 ? json({ items: [membership('o1', 'Northwind')] }) : refreshed(),
    });
    const user = userEvent.setup();
    await expectOrganizationChoice(s);
    await chooseOrganization('Northwind', user);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    await screen.findByText('Your scanning access changed. Choose an organization again.');
    expect(calls).toBe(2);
    expect(s.joins).toEqual([]);
    expect(s.onScope).not.toHaveBeenCalled();
    expect(s.requests.every((orgId) => orgId === 'o1')).toBe(true);
    expect(
      s.fetch.mock.calls.some(
        ([url, init]) => String(url).includes('/scanning-sessions') && init?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('removes cached organization access when refreshing memberships fails', async () => {
    let calls = 0;
    const s = setup({
      membershipResponse: () =>
        calls++ === 0
          ? json({ items: [membership('o1', 'Northwind')] })
          : problem(500, 'SERVER_ERROR', 'Failed to load memberships.'),
    });
    await expectOrganizationChoice(s);
    await chooseOrganization('Northwind');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    await s.client.invalidateQueries({ queryKey: ['scan', 'admin-orgs'] });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Organization/ })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: /Join session|Create and join/ }),
    ).not.toBeInTheDocument();
    expect(s.joins).toEqual([]);
  });

  it('does not use cached access while memberships are being refreshed', async () => {
    // The web build targets ES2023; the test runtime provides withResolvers.
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const response = deferred.withResolvers<Response>();
    let calls = 0;
    const s = setup({
      membershipResponse: () =>
        calls++ === 0 ? json({ items: [membership('o1', 'Northwind')] }) : response.promise,
    });
    await expectOrganizationChoice(s);
    await chooseOrganization('Northwind');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    const requestsBeforeRefresh = [...s.requests];
    const refreshing = s.client.invalidateQueries({ queryKey: ['scan', 'admin-orgs'] });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /Organization/ })).toBeDisabled(),
    );
    expect(
      screen.queryByRole('button', { name: /Join session|Create and join/ }),
    ).not.toBeInTheDocument();
    expect(s.requests).toEqual(requestsBeforeRefresh);
    response.resolve(json({ items: [] }));
    await refreshing;
    await screen.findByText('No organizations grant you scanning management access.');
    expect(s.joins).toEqual([]);
  });

  it('keeps loading and failed membership requests inaccessible and announces the error', async () => {
    // The web build targets ES2023; the test runtime provides withResolvers.
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const response = deferred.withResolvers<Response>();
    const s = setup({ membershipResponse: () => response.promise });
    expect(screen.getByRole('combobox', { name: /Organization/ })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: /Join session|Create and join/ }),
    ).not.toBeInTheDocument();
    expect(s.requests).toEqual([]);
    expect(s.fetch.mock.calls.some(([url]) => String(url).includes('/scanning-sessions'))).toBe(
      false,
    );
    expect(requestedPath(s, '/api/v1/session')).toBe(false);
    response.resolve(problem(500, 'SERVER_ERROR', 'Failed to load memberships.'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Organization/ })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: /Join session|Create and join/ }),
    ).not.toBeInTheDocument();
    expect(s.requests).toEqual([]);
    expect(s.fetch.mock.calls.some(([url]) => String(url).includes('/scanning-sessions'))).toBe(
      false,
    );
    expect(requestedPath(s, '/api/v1/session')).toBe(false);
    expect(s.joins).toEqual([]);
  });
});
