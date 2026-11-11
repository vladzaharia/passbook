import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { setMode } from '@/web/lib/mode.ts';
import { AppProviders } from '@/web/lib/providers.tsx';
import { createQueryClient } from '@/web/lib/query-client.ts';
import { json, problem, renderApp, sessionFixture, stubFetch } from '@/web/lib/test-utils.tsx';
import { createAppRouter } from '@/web/router.tsx';
import {
  enabledSendButton,
  handlers,
  harbor,
  operator,
  reader,
  sendRequests,
  setupInboxTest,
  verifiedEmails,
} from './inbox-page-test-fixtures.ts';

setupInboxTest();

describe('Test inbox', () => {
  it.each(['admin', 'user'] as const)(
    'lets a %s reader inspect mail without inheriting another organization’s operation permission',
    async (session) => {
      setMode('test');
      const user = userEvent.setup();
      const { fetchMock } = await renderApp('/admin/test-inbox?email=e1', {
        session,
        memberships: [reader, harbor],
        selectedOrg: 'o1',
        handlers,
      });
      await user.click(await screen.findByRole('radio', { name: 'Text' }));
      expect(screen.getByText('Hi there from the pass email.')).toBeInTheDocument();
      expect(screen.getByText(/Pass operation access is required/)).toBeInTheDocument();
      const button = screen.getByRole('button', { name: 'Send to me' });
      expect(button).toBeDisabled();
      await user.click(button);
      expect(
        fetchMock.mock.calls.some(
          ([url]) => new URL(String(url), 'http://localhost').pathname === '/api/v1/me/emails',
        ),
      ).toBe(false);
      expect(sendRequests(fetchMock)).toHaveLength(0);
    },
  );

  it('lets a non-platform operator preview and forward their organization’s test mail', async () => {
    setMode('test');
    const user = userEvent.setup();
    const { fetchMock } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'user',
      memberships: [operator],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/test-inbox/e1/send-to-me': () => json({ to: 'admin@example.com' }),
      },
    });
    expect(await screen.findByTitle('Email preview')).toHaveAttribute(
      'src',
      '/api/v1/test-inbox/e1/html?orgId=o1&mode=test',
    );
    await user.click(await enabledSendButton());
    expect(
      await screen.findByText(/provider accepted a copy for admin@example\.com/i),
    ).toBeInTheDocument();
    const sent = sendRequests(fetchMock)[0];
    expect(new URL(String(sent?.[0]), 'http://localhost').searchParams.get('orgId')).toBe('o1');
    expect((sent?.[1]?.headers as Record<string, string> | undefined)?.['x-passbook-mode']).toBe(
      'test',
    );
    expect(
      fetchMock.mock.calls.some(
        ([url]) => new URL(String(url), 'http://localhost').pathname === '/api/v1/settings',
      ),
    ).toBe(false);
  });

  it('does not request test mail for a non-member with an explicit organization', async () => {
    setMode('test');
    const requests = vi.fn(() => json({ items: [], nextCursor: null }));
    await renderApp('/admin/test-inbox?orgId=o1&email=e1', {
      session: 'user',
      memberships: [],
      handlers: { '/api/v1/test-inbox': requests },
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access' }),
    ).toBeInTheDocument();
    expect(requests).not.toHaveBeenCalled();
  });

  it.each([
    ['no email', { items: [] }, 'Verify an email address'],
    [
      'unverified email',
      {
        items: [{ email: 'admin@example.com', verifiedAt: null, verifiedVia: null, primary: true }],
      },
      'Verify an email address',
    ],
    ['failed verification lookup', null, 'Your account email could not be checked'],
  ] as const)('disables sending for an operator with %s', async (_case, addresses, message) => {
    setMode('test');
    const user = userEvent.setup();
    const { fetchMock } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      memberships: [operator],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/me/emails': () =>
          addresses ? json(addresses) : problem(503, 'UNAVAILABLE', 'Unavailable'),
      },
    });
    expect(await screen.findByText(new RegExp(message))).toBeInTheDocument();
    expect(screen.getByTitle('Email preview')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Send to me' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(sendRequests(fetchMock)).toHaveLength(0);
  });

  it.each([true, false])(
    'sends only after a verified own email is available (primary: %s)',
    async (primary) => {
      setMode('test');
      const user = userEvent.setup();
      const { fetchMock } = await renderApp('/admin/test-inbox?email=e1', {
        session: 'admin',
        memberships: [operator],
        selectedOrg: 'o1',
        handlers: {
          ...handlers,
          '/api/v1/me/emails': () =>
            json({
              items: [
                { email: 'own@example.com', verifiedAt: 1, verifiedVia: 'oidc', primary },
                ...(!primary
                  ? [
                      {
                        email: 'test@example.com',
                        verifiedAt: null,
                        verifiedVia: null,
                        primary: true,
                      },
                    ]
                  : []),
              ],
            }),
          '/api/v1/test-inbox/e1/send-to-me': () => json({ to: 'own@example.com' }),
        },
      });
      const button = await enabledSendButton();
      expect(screen.queryByText(/own@example\.com/)).not.toBeInTheDocument();
      await user.click(button);
      expect(
        await screen.findByText(/provider accepted a copy for own@example\.com/i),
      ).toBeInTheDocument();
      const sent = sendRequests(fetchMock)[0];
      expect(new URL(String(sent?.[0]), 'http://localhost').searchParams.get('orgId')).toBe('o1');
      expect((sent?.[1]?.headers as Record<string, string> | undefined)?.['x-passbook-mode']).toBe(
        'test',
      );
      expect(sent?.[1]?.body).toBeUndefined();
    },
  );

  it('keeps authorized sending available under React StrictMode', async () => {
    setMode('test');
    const user = userEvent.setup();
    let sends = 0;
    stubFetch({
      '/api/v1/session': () => json(sessionFixture('admin')),
      '/api/v1/orgs/memberships/me': () => json({ items: [operator] }),
      '/api/v1/orgs': () => json({ items: [], nextCursor: null }),
      ...handlers,
      '/api/v1/test-inbox/e1/send-to-me': () => {
        sends++;
        return json({ to: 'admin@example.com' });
      },
    });
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
    const history = createMemoryHistory({
      initialEntries: ['/admin/test-inbox?email=e1&orgId=o1'],
    });
    const router = createAppRouter({ queryClient, history });
    render(
      <StrictMode>
        <AppProviders queryClient={queryClient}>
          <RouterProvider router={router} />
        </AppProviders>
      </StrictMode>,
    );
    await user.click(await enabledSendButton());
    await waitFor(() => expect(sends).toBe(1));
  });

  it('disables an open send if the account email loses verification', async () => {
    setMode('test');
    const user = userEvent.setup();
    const { queryClient, fetchMock } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      memberships: [operator],
      selectedOrg: 'o1',
      handlers,
    });
    await enabledSendButton();
    act(() => {
      queryClient.setQueryData(['test-inbox', 'verified-emails', 'u1'], { items: [] });
    });
    expect(await screen.findByText(/Verify an email address/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Send to me' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(sendRequests(fetchMock)).toHaveLength(0);
  });

  it('rechecks verification after the server rejects a stale verified address', async () => {
    setMode('test');
    const user = userEvent.setup();
    let emailReads = 0;
    let sends = 0;
    await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      memberships: [operator],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/me/emails': () => json(++emailReads === 1 ? verifiedEmails : { items: [] }),
        '/api/v1/test-inbox/e1/send-to-me': () => {
          sends++;
          return problem(422, 'NO_VERIFIED_EMAIL', 'Verify your email.');
        },
      },
    });
    await user.click(await enabledSendButton());
    expect(await screen.findByText(/Verify an email address in your account/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Send to me' }));
    expect(emailReads).toBeGreaterThanOrEqual(2);
    expect(sends).toBe(1);
  });

  it('disables an open send when the selected membership loses operation permission', async () => {
    setMode('test');
    const user = userEvent.setup();
    const { queryClient, fetchMock } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'user',
      memberships: [operator],
      selectedOrg: 'o1',
      handlers,
    });
    await enabledSendButton();
    act(() => {
      queryClient.setQueryData(['org-memberships', 'me'], { items: [reader] });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled());
    await user.click(screen.getByRole('button', { name: 'Send to me' }));
    expect(screen.getByTitle('Email preview')).toBeInTheDocument();
    expect(sendRequests(fetchMock)).toHaveLength(0);
  });
});
