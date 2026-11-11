import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { deviceLabel } from '../lib/device.ts';
import { sessionQuery } from '../lib/session.ts';
import { json, problem, renderApp, sessionFixture } from '../lib/test-utils.tsx';
import { toast } from '../ui/index.ts';
import { myEmailsKey } from './api.ts';

const signOut = vi.hoisted(() => vi.fn(async () => {}));
const leaveSignedOut = vi.hoisted(() => vi.fn());
vi.mock('../lib/session.ts', async (orig) => ({
  ...(await orig<typeof import('../lib/session.ts')>()),
  signOut,
  leaveSignedOut,
}));

beforeEach(() => {
  signOut.mockClear();
  leaveSignedOut.mockClear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const emails = (over: object[] = []) => ({
  items: [
    { email: 'test@example.com', verifiedAt: 1, verifiedVia: 'oidc', primary: true },
    { email: 'work@example.com', verifiedAt: 2, verifiedVia: 'magic_link', primary: false },
    ...over,
  ],
});
const sessions = () => ({
  items: [
    {
      id: 's1',
      createdAt: 1,
      lastSeenAt: 2,
      userAgent: 'Mozilla/5.0 (Macintosh; Mac OS X) Safari/605',
      current: true,
    },
    {
      id: 's2',
      createdAt: 1,
      lastSeenAt: 2,
      userAgent: 'Mozilla/5.0 (iPhone) Safari/604',
      current: false,
    },
  ],
});

// The web test target predates Promise.withResolvers.
function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('deviceLabel', () => {
  it('summarises user agents', () => {
    expect(deviceLabel(null)).toBe('Unknown device');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10) Chrome/120 Safari/537')).toBe(
      'Chrome on Windows',
    );
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10) Edg/120 Chrome/120')).toBe('Edge on Windows');
    expect(deviceLabel('curl/8')).toBe('Unknown device');
  });
});

describe('account page', () => {
  it('lists emails and sessions without a11y violations', async () => {
    const { container } = await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    expect(await screen.findByText('work@example.com')).toBeInTheDocument();
    expect(await screen.findByText('This device')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke Safari on iOS' })).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Sessions' })).getAllByRole('listitem');
    for (const row of rows) expect(row.querySelector('svg')).not.toBeNull();
    expect(screen.queryByText(/^Name/)).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('adds an email as a pending row with Resend and Cancel, then sees it verified', async () => {
    const user = userEvent.setup();
    let items = emails();
    const posted: unknown[] = [];
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': (_u, init) => {
          if (init?.method === 'POST') {
            posted.push(JSON.parse(String(init.body)));
            return json({ ok: true }, 202);
          }
          return json(items);
        },
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    await user.type(await screen.findByLabelText('Add email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enter code' })).toBeNull();
    expect(posted).toEqual([{ email: 'new@example.com' }]);
    expect(sessionStorage.getItem('wallet-pending-emails:u1')).toContain('new@example.com');

    await user.click(screen.getByRole('button', { name: 'Actions for new@example.com' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Resend' }));
    expect(await screen.findByText('Sent again')).toBeInTheDocument();
    expect(posted).toHaveLength(2);

    // The user confirms in the email and comes back: the focus refetch shows it verified.
    items = emails([
      { email: 'new@example.com', verifiedAt: 3, verifiedVia: 'magic_link', primary: false },
    ]);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(screen.queryByText('Check your inbox')).toBeNull());
    expect(screen.getByText('new@example.com')).toBeInTheDocument();
    expect(sessionStorage.getItem('wallet-pending-emails:u1')).not.toContain('new@example.com');
    focusManager.setFocused(undefined);
  });

  it('keeps pending rows with their account across principal switches', async () => {
    const user = userEvent.setup();
    const first = sessionFixture('user');
    if (!first.authenticated) throw new Error('Expected an authenticated fixture');
    const second = { ...first, user: { ...first.user, id: 'u2' } };
    const { queryClient } = await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': (_u, init) =>
          init?.method === 'POST' ? json({ ok: true }, 202) : json({ items: [] }),
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });

    await user.type(await screen.findByLabelText('Add email'), 'first-pending@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('first-pending@example.com')).toBeInTheDocument();

    act(() => {
      queryClient.setQueryData(['session'], second);
    });
    await waitFor(() => expect(screen.queryByText('first-pending@example.com')).toBeNull());
    await user.type(await screen.findByLabelText('Add email'), 'second-pending@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('second-pending@example.com')).toBeInTheDocument();

    act(() => {
      queryClient.setQueryData(['session'], first);
    });
    expect(await screen.findByText('first-pending@example.com')).toBeInTheDocument();
    expect(screen.queryByText('second-pending@example.com')).toBeNull();
  });

  it('ignores an add-email completion from a previous principal', async () => {
    const user = userEvent.setup();
    const first = sessionFixture('user');
    if (!first.authenticated) throw new Error('Expected an authenticated fixture');
    const second = { ...first, user: { ...first.user, id: 'u2' } };
    let current = first;
    let requests = 0;
    const pending = deferredResponse();
    const { queryClient } = await renderApp('/account', {
      handlers: {
        '/api/v1/session': () => json(current),
        '/api/v1/me/emails': (_url, init) => {
          if (init?.method === 'POST') {
            requests += 1;
            return pending.promise;
          }
          return json({ items: [] });
        },
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });

    await user.type(await screen.findByLabelText('Add email'), 'old@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(requests).toBe(1));
    current = second;
    await act(async () => {
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    });
    await screen.findByLabelText('Add email');

    await act(async () => {
      pending.resolve(json({ ok: true }, 202));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText('old@example.com')).toBeNull();
    expect(sessionStorage.getItem('wallet-pending-emails:u1')).toBeNull();
    expect(sessionStorage.getItem('wallet-pending-emails:u2')).toBeNull();
  });

  it('ignores a resend completion after the principal changes', async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, 'success');
    const first = sessionFixture('user');
    if (!first.authenticated) throw new Error('Expected an authenticated fixture');
    const second = { ...first, user: { ...first.user, id: 'u2' } };
    let current = first;
    let requests = 0;
    const pending = deferredResponse();
    sessionStorage.setItem('wallet-pending-emails:u1', JSON.stringify(['old@example.com']));
    const { queryClient } = await renderApp('/account', {
      handlers: {
        '/api/v1/session': () => json(current),
        '/api/v1/me/emails': (_url, init) => {
          if (init?.method === 'POST') {
            requests += 1;
            return pending.promise;
          }
          return json({ items: [] });
        },
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Actions for old@example.com' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Resend' }));
    await waitFor(() => expect(requests).toBe(1));
    current = second;
    await act(async () => {
      await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    });
    await screen.findByLabelText('Add email');

    await act(async () => {
      pending.resolve(json({ ok: true }, 202));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(success).not.toHaveBeenCalledWith('Sent again');
    expect(sessionStorage.getItem('wallet-pending-emails:u1')).toBe('["old@example.com"]');
    expect(sessionStorage.getItem('wallet-pending-emails:u2')).toBeNull();
  });

  it.each(['primary', 'remove'] as const)(
    'does not apply a late %s email mutation to a different principal',
    async (action) => {
      const user = userEvent.setup();
      const first = sessionFixture('user');
      if (!first.authenticated) throw new Error('Expected an authenticated fixture');
      const second = { ...first, user: { ...first.user, id: 'u2' } };
      const nextEmails = {
        items: [{ email: 'second@example.com', verifiedAt: 1, verifiedVia: 'oidc', primary: true }],
      };
      let current = first;
      let requests = 0;
      let emailLoads = 0;
      const pending = deferredResponse();
      const respondLater = () => {
        requests += 1;
        return pending.promise;
      };
      const { queryClient } = await renderApp('/account', {
        handlers: {
          '/api/v1/session': () => json(current),
          '/api/v1/me/emails': () => {
            emailLoads += 1;
            return json(current.user.id === 'u1' ? emails() : nextEmails);
          },
          '/api/v1/me/emails/work%40example.com/primary': respondLater,
          '/api/v1/me/emails/work%40example.com': respondLater,
          '/api/v1/me/sessions': () => json(sessions()),
        },
      });

      await user.click(await screen.findByRole('button', { name: 'Actions for work@example.com' }));
      const label = action === 'primary' ? 'Make primary' : 'Remove';
      await user.click(await screen.findByRole('menuitem', { name: label }));
      await user.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: label }),
      );
      await waitFor(() => expect(requests).toBe(1));

      current = second;
      await act(async () => {
        await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
      });
      expect(await screen.findByText('second@example.com')).toBeInTheDocument();
      const loadsAfterSwitch = emailLoads;
      await act(async () => {
        pending.resolve(json(action === 'primary' ? emails() : { ok: true }));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(queryClient.getQueryData(myEmailsKey)).toEqual(nextEmails);
      expect(emailLoads).toBe(loadsAfterSwitch);
    },
  );

  it('shows an unverified primary with Verify, no Remove, then verified after the link', async () => {
    const user = userEvent.setup();
    let items = {
      items: [{ email: 'test@example.com', verifiedAt: null, verifiedVia: null, primary: true }],
    };
    const posted: unknown[] = [];
    const { container } = await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': (_u, init) => {
          if (init?.method === 'POST') {
            posted.push(JSON.parse(String(init.body)));
            return json({ ok: true }, 202);
          }
          return json(items);
        },
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    const list = within(await screen.findByRole('list', { name: 'Emails' }));
    expect(await list.findByText('Not verified')).toBeInTheDocument();
    expect(list.queryByText('No emails')).toBeNull();
    expect(list.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect((await axe(container)).violations).toEqual([]);

    await user.click(list.getByRole('button', { name: 'Verify' }));
    expect(posted).toEqual([{ email: 'test@example.com' }]);
    expect(await list.findByText('Check your inbox')).toBeInTheDocument();

    items = {
      items: [
        { email: 'test@example.com', verifiedAt: 5, verifiedVia: 'magic_link', primary: true },
      ],
    } as unknown as typeof items;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(screen.queryByText('Check your inbox')).toBeNull());
    expect(screen.queryByText('Not verified')).toBeNull();
    expect(screen.getAllByText('test@example.com').length).toBeGreaterThan(0);
    const rows = within(screen.getByRole('list', { name: 'Emails' })).getAllByText(
      'test@example.com',
    );
    expect(rows).toHaveLength(1);
    focusManager.setFocused(undefined);
  });

  it('cancels a pending address', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem('wallet-pending-emails:u1', JSON.stringify(['later@example.com']));
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Actions for later@example.com' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('later@example.com')).toBeNull());
  });

  it('rejects an invalid email locally and shows server errors', async () => {
    const user = userEvent.setup();
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': (_u, init) =>
          init?.method === 'POST'
            ? problem(429, 'RATE_LIMITED', 'Too many requests. Try again in a minute.')
            : json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    const input = await screen.findByLabelText('Add email');
    await user.type(input, 'bad');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    // A refused address stays in the field to be fixed.
    expect(screen.getByLabelText('Add email')).toHaveValue('bad');
    await user.clear(screen.getByLabelText('Add email'));
    await user.type(screen.getByLabelText('Add email'), 'work@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('That email is already on your account.')).toBeInTheDocument();
    expect(screen.getByLabelText('Add email')).toHaveValue('work@example.com');
    await user.clear(screen.getByLabelText('Add email'));
    await user.type(screen.getByLabelText('Add email'), 'taken@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(
      await screen.findByText('Too many requests. Try again in a minute.'),
    ).toBeInTheDocument();
    // The server refused it: the address stays to retry or fix.
    expect(screen.getByLabelText('Add email')).toHaveValue('taken@example.com');
  });

  it('confirms an address the add-email link verified, then drops it from the URL', async () => {
    const { router } = await renderApp('/account?verified=new%40example.com', {
      handlers: {
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    expect(await screen.findByText('Email added')).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(router.state.location.href).toBe('/account');
    expect(screen.getAllByText('Email added')).toHaveLength(1);
  });

  it('removes a non-primary email after confirming; primary has no actions', async () => {
    const user = userEvent.setup();
    let removed = '';
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json(removed ? { items: emails().items.slice(0, 1) } : emails()),
        '/api/v1/me/emails/work%40example.com': (_u, init) => {
          if (init?.method === 'DELETE') removed = 'work@example.com';
          return json({ items: emails().items.slice(0, 1) });
        },
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    await screen.findByText('work@example.com');
    expect(screen.queryByRole('button', { name: 'Actions for test@example.com' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Actions for work@example.com' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    expect(
      within(await screen.findByRole('alertdialog')).getByText(
        /Passes already assigned to you may remain in your collection/,
      ),
    ).toBeInTheDocument();
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(screen.queryByText('work@example.com')).toBeNull());
    expect(removed).toBe('work@example.com');
  });

  it('makes another verified email primary after confirming', async () => {
    const user = userEvent.setup();
    let sessionCalls = 0;
    const swapped = {
      items: [
        { email: 'test@example.com', verifiedAt: 1, verifiedVia: 'oidc', primary: false },
        { email: 'work@example.com', verifiedAt: 2, verifiedVia: 'magic_link', primary: true },
      ],
    };
    await renderApp('/account', {
      handlers: {
        '/api/v1/session': () => {
          sessionCalls++;
          return json(sessionFixture('user'));
        },
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/emails/work%40example.com/primary': () => json(swapped),
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Actions for work@example.com' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Make primary' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Sign-in emails go to work@example.com.');
    const before = sessionCalls;
    await user.click(within(dialog).getByRole('button', { name: 'Make primary' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Actions for test@example.com' })).toBeVisible(),
    );
    await waitFor(() => expect(sessionCalls).toBeGreaterThan(before));
  });

  it('focuses the add row when asked to add another email', async () => {
    await renderApp('/account?add=email', {
      handlers: {
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    const input = await screen.findByLabelText('Add email');
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('revokes another session', async () => {
    const user = userEvent.setup();
    let revoked = false;
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/sessions': () =>
          json(revoked ? { items: sessions().items.slice(0, 1) } : sessions()),
        '/api/v1/me/sessions/s2': () => {
          revoked = true;
          return json({ ok: true });
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Revoke Safari on iOS' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Revoke / })).toBeNull());
    expect(revoked).toBe(true);
  });

  it('signs out everywhere with one logout call that keeps the provider sign-out', async () => {
    const user = userEvent.setup();
    const calls: { url: string; csrf: string | null }[] = [];
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
        '/auth/logout': (url, init) => {
          calls.push({
            url: `${url.pathname}${url.search}`,
            csrf: new Headers(init?.headers).get('x-csrf-token'),
          });
          return json({ ok: true, redirect: 'https://id.test/end-session' });
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out' }),
    );
    await waitFor(() => expect(leaveSignedOut).toHaveBeenCalledWith('https://id.test/end-session'));
    expect(calls).toEqual([{ url: '/auth/logout?all=1', csrf: 'csrf-test' }]);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('does not leave when signing out everywhere fails', async () => {
    const user = userEvent.setup();
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
        '/auth/logout': () => problem(500, 'server_error', 'x'),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    expect(await within(dialog).findByText('Something went wrong. Try again.')).toBeInTheDocument();
    expect(leaveSignedOut).not.toHaveBeenCalled();
  });

  it('leaves sign-out to the account menu: Sign out everywhere only on Sessions', async () => {
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    await screen.findByText('work@example.com');
    const main = screen.getByRole('main');
    expect(within(main).queryByRole('button', { name: 'Sign out' })).toBeNull();
    const everywhere = within(main).getAllByRole('button', { name: 'Sign out everywhere' });
    expect(everywhere).toHaveLength(1);
    const sessionsCard = screen.getByRole('heading', { name: 'Sessions' }).parentElement
      ?.parentElement as HTMLElement;
    expect(sessionsCard).toContainElement(everywhere[0] as HTMLElement);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('renders inside the console shell at /admin/account', async () => {
    await renderApp('/admin/account', {
      session: 'admin',
      handlers: {
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument();
    expect(await screen.findByText('work@example.com')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument();
    expect(within(screen.getByRole('main')).queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});
