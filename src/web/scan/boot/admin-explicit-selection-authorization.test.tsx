import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { json, problem, sessionFixture } from '../../lib/test-utils.tsx';
import {
  chooseOrg,
  cleanupExplicitSelection,
  expectNoGlobalOrgs,
  expectStartUnavailable,
  joinedScope,
  type Membership,
  membership,
  requests,
  sessionRequests,
  setup,
} from './admin-explicit-selection-test-fixtures.ts';

afterEach(cleanupExplicitSelection);

describe('scanner admin organization membership authorization', () => {
  it.each([
    { label: 'absent membership', memberships: [] },
    {
      label: 'revoked membership',
      memberships: [{ ...membership('o1', 'Northwind'), revokedAt: 2 }],
    },
    {
      label: 'another user’s membership',
      memberships: [{ ...membership('o1', 'Northwind'), userId: 'u2' }],
    },
    { label: 'read-only membership', memberships: [membership('o1', 'Northwind', false)] },
  ])('exposes no start action for $label, even with a deep link', async ({ memberships }) => {
    const s = setup({
      memberships,
      identity: sessionFixture('admin'),
      path: '/scan?orgId=o1&sessionId=session-1',
    });
    await screen.findByText('No organizations grant you scanning management access.');
    expect(screen.queryByRole('combobox', { name: /Organization/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^(Join session|Create and join)$/ }),
    ).not.toBeInTheDocument();
    expect(sessionRequests(s.fetch)).toHaveLength(0);
    expect(s.onScope).not.toHaveBeenCalled();
    expectNoGlobalOrgs(s.fetch);
  });

  it('offers only active same-user managers and never follows an unauthorized session hint', async () => {
    const s = setup({
      memberships: [
        membership('o1', 'Northwind'),
        membership('o2', 'Southwind', false),
        { ...membership('o3', 'Revoked'), revokedAt: 2 },
        { ...membership('o4', 'Other user'), userId: 'u2' },
      ],
      path: '/scan?orgId=o2&sessionId=session-2',
    });
    const user = userEvent.setup();
    const select = await screen.findByRole('combobox', { name: /Organization/ });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveTextContent('Choose an organization');
    expectStartUnavailable();
    expect(sessionRequests(s.fetch)).toHaveLength(0);

    await user.click(select);
    expect(await screen.findByRole('option', { name: 'Northwind' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Southwind' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Revoked' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Other user' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Northwind' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    expect(requests(s.fetch, '/api/v1/scanning-sessions/session-2')).toHaveLength(0);
    const list = requests(s.fetch, '/api/v1/scanning-sessions');
    expect(list).toHaveLength(1);
    expect(new URL(String(list[0]?.[0]), 'http://localhost').searchParams.get('orgId')).toBe('o1');
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    await waitFor(() => expect(s.onScope).toHaveBeenCalledWith(joinedScope));
    const join = requests(s.fetch, '/api/v1/scanning-sessions/join', 'POST');
    expect(JSON.parse(String(join[0]?.[1]?.body))).toMatchObject({ sessionId: 'session-1' });
    expect(requests(s.fetch, '/api/v1/scanning-sessions/session-2')).toHaveLength(0);
    expectNoGlobalOrgs(s.fetch);
  });

  it('hides start actions while memberships load and if the request fails', async () => {
    // The web type-library target is ES2023; tests run on Node 24.
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const pending = deferred.withResolvers<Response>();
    const s = setup({
      path: '/scan?orgId=o1&sessionId=session-1',
      membershipResponse: () => pending.promise,
    });
    expect(
      screen.queryByRole('button', { name: /^(Join session|Create and join)$/ }),
    ).not.toBeInTheDocument();
    expect(sessionRequests(s.fetch)).toHaveLength(0);
    await act(async () => {
      pending.resolve(problem(500, 'SERVER_ERROR', 'Failed to load memberships.'));
      await pending.promise;
    });
    await screen.findByRole('alert');
    expect(
      screen.queryByRole('button', { name: /^(Join session|Create and join)$/ }),
    ).not.toBeInTheDocument();
    expect(sessionRequests(s.fetch)).toHaveLength(0);
    expect(s.onScope).not.toHaveBeenCalled();
    expectNoGlobalOrgs(s.fetch);
  });

  it.each(['revoked', 'failed'] as const)(
    'disables cached access during a membership refresh that becomes %s',
    async (outcome) => {
      // The web type-library target is ES2023; tests run on Node 24.
      const deferred = Promise as PromiseConstructor & {
        withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
      };
      const { promise: refreshed, resolve: resolveRefresh } = deferred.withResolvers<Response>();
      let count = 0;
      const current = membership('o1', 'Northwind');
      const s = setup({
        membershipResponse: () => (count++ === 0 ? json({ items: [current] }) : refreshed),
      });
      await chooseOrg();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled(),
      );
      const before = sessionRequests(s.fetch).length;
      let refreshing: Promise<void> = Promise.resolve();
      act(() => {
        refreshing = s.client.invalidateQueries({ queryKey: ['scan', 'admin-orgs'] });
      });
      await waitFor(() =>
        expect(screen.getByRole('combobox', { name: /Organization/ })).toBeDisabled(),
      );
      expectStartUnavailable();
      await act(async () => {
        resolveRefresh(
          outcome === 'revoked'
            ? json({ items: [{ ...current, revokedAt: 2 }] })
            : problem(500, 'SERVER_ERROR', 'Failed to load memberships.'),
        );
        await refreshing;
      });
      if (outcome === 'revoked') {
        await screen.findByText('No organizations grant you scanning management access.');
        expect(
          screen.queryByRole('button', { name: /^(Join session|Create and join)$/ }),
        ).not.toBeInTheDocument();
      } else {
        await screen.findByRole('alert');
        expectStartUnavailable();
      }
      expect(sessionRequests(s.fetch)).toHaveLength(before);
      expect(s.onScope).not.toHaveBeenCalled();
      expectNoGlobalOrgs(s.fetch);
    },
  );

  it.each([
    { label: 'the same membership', id: 'membership-o1' },
    { label: 'a replacement membership', id: 'membership-o1-regranted' },
  ])('requires a fresh choice when $label returns after revocation', async ({ id }) => {
    const initial = membership('o1', 'Northwind');
    let memberships: Membership[] = [initial];
    const s = setup({
      path: '/scan?orgId=o1&sessionId=session-1',
      membershipResponse: () => json({ items: memberships }),
    });
    await chooseOrg();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    const before = sessionRequests(s.fetch).length;

    memberships = [];
    await act(async () => {
      await s.client.invalidateQueries({ queryKey: ['scan', 'admin-orgs'] });
    });
    await screen.findByText('No organizations grant you scanning management access.');
    expect(
      screen.queryByRole('button', { name: /^(Join session|Create and join)$/ }),
    ).not.toBeInTheDocument();
    expect(sessionRequests(s.fetch)).toHaveLength(before);

    memberships = [{ ...initial, id }];
    await act(async () => {
      await s.client.invalidateQueries({ queryKey: ['scan', 'admin-orgs'] });
    });
    const select = await screen.findByRole('combobox', { name: /Organization/ });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveTextContent('Choose an organization');
    expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
    expect(sessionRequests(s.fetch)).toHaveLength(before);
    expect(s.onScope).not.toHaveBeenCalled();

    await chooseOrg();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    expectNoGlobalOrgs(s.fetch);
  });

  it('does not silently switch organizations if a refreshed membership keeps its ID', async () => {
    const initial = membership('o1', 'Northwind');
    let current = initial;
    const s = setup({ membershipResponse: () => json({ items: [current] }) });
    await chooseOrg();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    const before = sessionRequests(s.fetch).length;

    current = { ...membership('o2', 'Southwind'), id: initial.id };
    await act(async () => {
      await s.client.invalidateQueries({ queryKey: ['scan', 'admin-orgs'] });
    });
    const select = await screen.findByRole('combobox', { name: /Organization/ });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveTextContent('Choose an organization');
    expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
    expect(sessionRequests(s.fetch)).toHaveLength(before);
    expect(s.onScope).not.toHaveBeenCalled();

    await chooseOrg('Southwind');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    const lists = requests(s.fetch, '/api/v1/scanning-sessions');
    expect(new URL(String(lists.at(-1)?.[0]), 'http://localhost').searchParams.get('orgId')).toBe(
      'o2',
    );
    expectNoGlobalOrgs(s.fetch);
  });
});
