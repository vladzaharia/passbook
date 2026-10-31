import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '../lib/test-utils.tsx';
import { deviceLabel } from './account-sessions.tsx';

const signOut = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../lib/session.ts', async (orig) => ({
  ...(await orig<typeof import('../lib/session.ts')>()),
  signOut,
}));

beforeEach(() => signOut.mockClear());
afterEach(() => vi.unstubAllGlobals());

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
    expect(
      screen.getByRole('button', { name: 'Revoke Safari on iOS session' }),
    ).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('adds an email and shows the code form for unverified rows', async () => {
    const user = userEvent.setup();
    let items = emails();
    const posted: unknown[] = [];
    const consumed: unknown[] = [];
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': (_u, init) => {
          if (init?.method === 'POST') {
            posted.push(JSON.parse(String(init.body)));
            items = emails([
              { email: 'new@example.com', verifiedAt: null, verifiedVia: null, primary: false },
            ]);
            return json({ ok: true }, 202);
          }
          return json(items);
        },
        '/api/v1/me/sessions': () => json(sessions()),
        '/auth/magic/consume': (_u, init) => {
          consumed.push(JSON.parse(String(init?.body)));
          items = emails([
            { email: 'new@example.com', verifiedAt: 3, verifiedVia: 'magic_link', primary: false },
          ]);
          return json({});
        },
      },
    });
    await user.type(await screen.findByLabelText('Add email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Unverified')).toBeInTheDocument();
    expect(posted).toEqual([{ email: 'new@example.com' }]);

    await user.type(await screen.findByLabelText('Code'), '654321');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.queryByText('Unverified')).toBeNull());
    expect(consumed).toEqual([{ email: 'new@example.com', code: '654321' }]);
  });

  it('rejects an invalid email locally and shows server errors', async () => {
    const user = userEvent.setup();
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': (_u, init) =>
          init?.method === 'POST'
            ? problem(409, 'email_taken', 'That email belongs to another account.')
            : json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    const input = await screen.findByLabelText('Add email');
    await user.type(input, 'bad');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Enter a valid email.')).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'taken@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('That email belongs to another account.')).toBeInTheDocument();
  });

  it('removes a non-primary email after confirming; primary has no remove', async () => {
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
    expect(screen.queryByRole('button', { name: 'Remove test@example.com' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove work@example.com' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(screen.queryByText('work@example.com')).toBeNull());
    expect(removed).toBe('work@example.com');
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
    await user.click(await screen.findByRole('button', { name: 'Revoke Safari on iOS session' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Revoke / })).toBeNull());
    expect(revoked).toBe(true);
  });

  it('signs out everywhere with one revoke-all call, then signs out', async () => {
    const user = userEvent.setup();
    const revoked: string[] = [];
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
        '/api/v1/me/sessions/revoke-all': () => {
          revoked.push('all');
          return json({ ok: true });
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out' }),
    );
    await waitFor(() => expect(signOut).toHaveBeenCalledWith('csrf-test'));
    expect(revoked).toEqual(['all']);
  });

  it('does not sign out when a revoke fails', async () => {
    const user = userEvent.setup();
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
        '/api/v1/me/sessions/revoke-all': () => problem(500, 'server_error', 'x'),
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    expect(await within(dialog).findByText('Server error. Try again.')).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('signs out this session', async () => {
    const user = userEvent.setup();
    await renderApp('/account', {
      handlers: {
        '/api/v1/me/emails': () => json(emails()),
        '/api/v1/me/sessions': () => json(sessions()),
      },
    });
    const buttons = await screen.findAllByRole('button', { name: 'Sign out' });
    await user.click(buttons[buttons.length - 1] as HTMLElement);
    expect(signOut).toHaveBeenCalledWith('csrf-test');
  });
});
