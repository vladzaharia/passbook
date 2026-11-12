import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { setMode } from '@/web/lib/mode.ts';
import { json, renderApp, sessionFixture } from '@/web/lib/test-utils.tsx';
import {
  deferredResponse,
  detail,
  email,
  enabledSendButton,
  handlers,
  harbor,
  operator,
  sendRequests,
  setupInboxTest,
  verifiedEmails,
} from './inbox-page-test-fixtures.ts';

setupInboxTest();

/** The open preview is modal, so the top bar is out of reach: change scope the way the bar does. */
async function switchOrg(router: Awaited<ReturnType<typeof renderApp>>['router'], orgId: string) {
  await act(async () => {
    await router.navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, orgId }),
      replace: true,
    });
  });
}

describe('Test inbox', () => {
  it('does not request a list, detail or send without a selected organization', async () => {
    setMode('test');
    const { fetchMock } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      memberships: [operator],
      handlers,
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose an organization' }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        new URL(String(url), 'http://localhost').pathname.startsWith('/api/v1/test-inbox'),
      ),
    ).toBe(false);
    expect(screen.queryByTitle('Email preview')).not.toBeInTheDocument();
  });

  it('closes the preview and hides old rows immediately when the organization changes', async () => {
    setMode('test');
    const user = userEvent.setup();
    const nextPage = deferredResponse();
    const requests: string[] = [];
    const { fetchMock, router } = await renderApp('/admin/test-inbox', {
      session: 'admin',
      memberships: [operator, harbor],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/test-inbox': (url) => {
          const org = url.searchParams.get('orgId') ?? '';
          requests.push(org);
          return org === 'o1'
            ? json({ items: [email({ subject: 'North message' })], nextCursor: null })
            : nextPage.promise;
        },
      },
    });
    await user.click(await screen.findByRole('link', { name: 'Open North message' }));
    expect(await screen.findByTitle('Email preview')).toBeInTheDocument();
    await switchOrg(router, 'o2');
    await waitFor(() => expect(requests).toContain('o2'));
    expect(screen.queryByTitle('Email preview')).not.toBeInTheDocument();
    expect(screen.queryByText('North message')).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([u]) => {
        const url = new URL(String(u), 'http://localhost');
        return url.pathname === '/api/v1/test-inbox/e1' && url.searchParams.get('orgId') === 'o2';
      }),
    ).toBe(false);
    await act(async () =>
      nextPage.resolve(
        json({
          items: [email({ id: 'e2', orgId: 'o2', subject: 'Harbor message' })],
          nextCursor: null,
        }),
      ),
    );
    expect(await screen.findByText('Harbor message')).toBeInTheDocument();
    expect(requests.every((org) => org === 'o1' || org === 'o2')).toBe(true);
  });

  it('aborts a pending scoped send on an organization switch', async () => {
    setMode('test');
    const user = userEvent.setup();
    const response = deferredResponse();
    const request: { signal: AbortSignal | null | undefined } = { signal: undefined };
    const { fetchMock, router } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      memberships: [operator, harbor],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/test-inbox': (url) =>
          json({
            items: url.searchParams.get('orgId') === 'o1' ? [email()] : [],
            nextCursor: null,
          }),
        '/api/v1/test-inbox/e1/send-to-me': (_url, init) => {
          request.signal = init?.signal;
          return response.promise;
        },
      },
    });
    await user.click(await enabledSendButton());
    await waitFor(() => expect(request.signal).toBeDefined());
    await switchOrg(router, 'o2');
    await waitFor(() => expect(request.signal?.aborted).toBe(true));
    expect(screen.queryByTitle('Email preview')).not.toBeInTheDocument();
    expect(sendRequests(fetchMock)).toHaveLength(1);
    await act(async () => response.resolve(json({ to: 'admin@example.com' })));
  });

  it('does not reuse another principal’s verified email when the session changes', async () => {
    setMode('test');
    let emailReads = 0;
    const { queryClient, fetchMock } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      memberships: [operator],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/me/emails': () => {
          emailReads++;
          return emailReads === 1 ? json(verifiedEmails) : json({ items: [] });
        },
      },
    });
    await enabledSendButton();
    const next = sessionFixture('admin');
    if (!next.authenticated) throw new Error('Expected an authenticated fixture.');
    act(() => {
      queryClient.setQueryData(['session'], {
        ...next,
        user: { ...next.user, id: 'u2', primaryEmail: 'second@example.com' },
      });
      queryClient.setQueryData(['org-memberships', 'me'], {
        items: [{ ...operator, userId: 'u2' }],
      });
    });
    // The page remounts for the new principal and the ?email link opens for them, not from cache.
    await waitFor(() => expect(screen.queryByTitle('Email preview')).not.toBeInTheDocument());
    expect(await screen.findByText(/Verify an email address/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to me' })).toBeDisabled();
    expect(screen.queryByText(/admin@example\.com/)).not.toBeInTheDocument();
    expect(emailReads).toBeGreaterThanOrEqual(2);
    expect(sendRequests(fetchMock)).toHaveLength(0);
  });

  it('drops the open preview on a mode switch instead of restoring it later', async () => {
    setMode('test');
    await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      memberships: [operator],
      selectedOrg: 'o1',
      handlers,
    });
    expect(await screen.findByTitle('Email preview')).toBeInTheDocument();
    act(() => setMode('live'));
    expect(await screen.findByText('Test mode is off')).toBeInTheDocument();
    expect(screen.queryByTitle('Email preview')).not.toBeInTheDocument();
    act(() => setMode('test'));
    expect(await screen.findByText('Your Gym pass')).toBeInTheDocument();
    expect(screen.queryByTitle('Email preview')).not.toBeInTheDocument();
  });

  it('refuses a detail returned for a different organization', async () => {
    setMode('test');
    const { fetchMock } = await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      memberships: [operator, harbor],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/test-inbox/e1': () => json({ ...detail(), orgId: 'o2' }),
      },
    });
    expect(await screen.findByRole('button', { name: 'Reload email' })).toBeInTheDocument();
    expect(screen.queryByTitle('Email preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to me' })).not.toBeInTheDocument();
    expect(sendRequests(fetchMock)).toHaveLength(0);
  });

  it('rejects list results belonging to another organization', async () => {
    setMode('test');
    await renderApp('/admin/test-inbox', {
      session: 'admin',
      memberships: [operator, harbor],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/test-inbox': () =>
          json({
            items: [email({ orgId: 'o2', subject: 'Other organization' })],
            nextCursor: null,
          }),
      },
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Other organization')).not.toBeInTheDocument();
  });

  it('does not display a returned recipient that is not one of the verified own emails', async () => {
    setMode('test');
    const user = userEvent.setup();
    await renderApp('/admin/test-inbox?email=e1', {
      session: 'admin',
      memberships: [operator],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/test-inbox/e1/send-to-me': () => json({ to: 'other@example.com' }),
      },
    });
    await user.click(await enabledSendButton());
    expect(await screen.findByText('Copy accepted by email provider')).toBeInTheDocument();
    expect(screen.queryByText(/other@example\.com/)).not.toBeInTheDocument();
  });
});
