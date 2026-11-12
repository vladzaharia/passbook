import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreProviders } from '../../lib/core-providers.tsx';
import { json, sessionFixture } from '../../lib/test-utils.tsx';
import {
  chooseOrg,
  cleanupExplicitSelection,
  expectNoGlobalOrgs,
  joinedScope,
  membership,
  requests,
  sessionRequests,
  setup,
} from './admin-explicit-selection-test-fixtures.ts';
import { AdminStart } from './admin-start.tsx';

afterEach(cleanupExplicitSelection);

describe('scanner admin explicit organization selection', () => {
  it('does not select a sole manageable organization or load sessions until it is chosen', async () => {
    const s = setup();
    const user = userEvent.setup();
    const select = await screen.findByRole('combobox', { name: /Organization/ });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveTextContent('Choose an organization');
    expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
    expect(sessionRequests(s.fetch)).toHaveLength(0);

    await user.click(select);
    const option = await screen.findByRole('option', { name: 'Northwind' });
    expect(sessionRequests(s.fetch)).toHaveLength(0);
    // The open listbox hides the rest of the page from the accessibility tree.
    expect(screen.getByRole('button', { name: 'Join session', hidden: true })).toBeDisabled();
    await user.click(option);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    const list = requests(s.fetch, '/api/v1/scanning-sessions');
    expect(list).toHaveLength(1);
    expect(new URL(String(list[0]?.[0]), 'http://localhost').searchParams.get('orgId')).toBe('o1');
    expect(s.onScope).not.toHaveBeenCalled();
    expectNoGlobalOrgs(s.fetch);
  });

  it('follows an authorized organization and session hint only after the organization is chosen', async () => {
    const s = setup({
      path: '/scan?orgId=o1&sessionId=session-1',
      lists: { o1: [] },
    });
    const user = userEvent.setup();
    const select = await screen.findByRole('combobox', { name: /Organization/ });
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveTextContent('Choose an organization');
    expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
    expect(sessionRequests(s.fetch)).toHaveLength(0);

    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Northwind' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    expect(requests(s.fetch, '/api/v1/scanning-sessions/session-1')).toHaveLength(1);
    expect(requests(s.fetch, '/api/v1/scanning-sessions')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    await waitFor(() => expect(s.onScope).toHaveBeenCalledWith(joinedScope));
    const join = requests(s.fetch, '/api/v1/scanning-sessions/join', 'POST');
    expect(join).toHaveLength(1);
    expect(JSON.parse(String(join[0]?.[1]?.body))).toMatchObject({ sessionId: 'session-1' });
    expectNoGlobalOrgs(s.fetch);
  });

  it('requires a fresh choice when the account changes and when the first account returns', async () => {
    let userId = 'u1';
    const s = setup({
      path: '/scan?orgId=o1&sessionId=session-1',
      membershipResponse: () => json({ items: [{ ...membership('o1', 'Northwind'), userId }] }),
    });
    await chooseOrg();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    const firstUserRequests = sessionRequests(s.fetch).length;
    expect(firstUserRequests).toBeGreaterThan(0);

    userId = 'u2';
    s.rerender(
      <CoreProviders queryClient={s.client}>
        <AdminStart userId="u2" onScope={s.onScope} />
      </CoreProviders>,
    );
    const secondSelect = await screen.findByRole('combobox', { name: /Organization/ });
    await waitFor(() => expect(secondSelect).toBeEnabled());
    expect(secondSelect).toHaveTextContent('Choose an organization');
    expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
    expect(sessionRequests(s.fetch)).toHaveLength(firstUserRequests);

    await chooseOrg();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    const secondUserRequests = sessionRequests(s.fetch).length;
    expect(secondUserRequests).toBeGreaterThan(firstUserRequests);

    userId = 'u1';
    s.rerender(
      <CoreProviders queryClient={s.client}>
        <AdminStart userId="u1" onScope={s.onScope} />
      </CoreProviders>,
    );
    const returningSelect = await screen.findByRole('combobox', { name: /Organization/ });
    await waitFor(() => expect(returningSelect).toBeEnabled());
    expect(returningSelect).toHaveTextContent('Choose an organization');
    expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
    expect(sessionRequests(s.fetch)).toHaveLength(secondUserRequests);
    expect(s.onScope).not.toHaveBeenCalled();
    expectNoGlobalOrgs(s.fetch);
  });

  it.each(['identity', 'join'] as const)(
    'abandons a pending %s response when the account changes',
    async (stage) => {
      // The web type-library target is ES2023; tests run on Node 24.
      const deferred = Promise as PromiseConstructor & {
        withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
      };
      const pending = deferred.withResolvers<Response>();
      let userId = 'u1';
      const s = setup({
        membershipResponse: () => json({ items: [{ ...membership('o1', 'Northwind'), userId }] }),
        ...(stage === 'identity'
          ? { identityResponse: () => pending.promise }
          : { joinResponse: () => pending.promise }),
      });
      const user = await chooseOrg();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled(),
      );
      await user.click(screen.getByRole('button', { name: 'Join session' }));

      const path = stage === 'identity' ? '/api/v1/session' : '/api/v1/scanning-sessions/join';
      const method = stage === 'identity' ? 'GET' : 'POST';
      await waitFor(() => expect(requests(s.fetch, path, method)).toHaveLength(1));
      const index = s.fetch.mock.calls.findIndex(
        ([input, init]) =>
          new URL(String(input), 'http://localhost').pathname === path &&
          (init?.method ?? 'GET') === method,
      );
      const signal = s.fetch.mock.calls[index]?.[1]?.signal;
      const result = s.fetch.mock.results[index];
      if (result?.type !== 'return') throw new Error('Expected the pending fetch.');
      const oldFetch = result.value;
      expect(signal?.aborted).toBe(false);

      userId = 'u2';
      s.rerender(
        <CoreProviders queryClient={s.client}>
          <AdminStart userId="u2" onScope={s.onScope} />
        </CoreProviders>,
      );
      const select = await screen.findByRole('combobox', { name: /Organization/ });
      await waitFor(() => expect(select).toBeEnabled());
      expect(select).toHaveTextContent('Choose an organization');
      expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
      expect(signal?.aborted).toBe(true);
      const membershipCalls = requests(s.fetch, '/api/v1/orgs/memberships/me').length;
      const writes = s.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').length;
      expect(writes).toBe(stage === 'identity' ? 0 : 1);

      await act(async () => {
        pending.resolve(json(stage === 'identity' ? sessionFixture('user') : joinedScope));
        await oldFetch;
      });
      expect(requests(s.fetch, '/api/v1/orgs/memberships/me')).toHaveLength(membershipCalls);
      expect(s.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(writes);
      expect(s.onScope).not.toHaveBeenCalled();
      expect(select).toHaveTextContent('Choose an organization');
      expect(screen.getByRole('button', { name: 'Join session' })).toBeDisabled();
      expectNoGlobalOrgs(s.fetch);
    },
  );

  it('aborts a pending join if the selected membership is revoked', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const pending = deferred.withResolvers<Response>();
    const s = setup({ joinResponse: () => pending.promise });
    const user = await chooseOrg();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Join session' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Join session' }));
    await waitFor(() =>
      expect(requests(s.fetch, '/api/v1/scanning-sessions/join', 'POST')).toHaveLength(1),
    );
    const request = requests(s.fetch, '/api/v1/scanning-sessions/join', 'POST')[0];
    const signal = request?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    act(() => {
      s.client.setQueryData(['scan', 'admin-orgs', 'u1'], {
        items: [{ ...membership('o1', 'Northwind'), revokedAt: 2 }],
      });
    });
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await act(async () => {
      pending.resolve(json(joinedScope));
      await pending.promise;
    });
    expect(s.onScope).not.toHaveBeenCalled();
    expect(
      await screen.findByText('No organizations grant you scanning management access.'),
    ).toBeInTheDocument();
  });
});
