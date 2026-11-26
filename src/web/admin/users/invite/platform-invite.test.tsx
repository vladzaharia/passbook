import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';

const user = {
  id: 'u2',
  name: 'Ada Lovelace',
  primaryEmail: 'ada@example.com',
  status: 'active',
  lastRoles: ['user'],
  createdAt: 1,
  lastLoginAt: 1,
  passCount: 0,
  signInMethods: ['oidc'],
};
const status = (connected: boolean) => ({
  connected,
  mode: 'live',
  frozen: false,
  keyExpiresAt: null,
  problems: [],
  budget: {},
  lastScimAt: null,
  drift: {},
  breakerOpen: false,
});
const group = {
  key: 'staff',
  kind: 'custom',
  name: 'passbook_g_staff',
  friendlyName: 'Staff',
  members: 2,
  claims: [],
  otherClients: 0,
  flags: [],
  rules: 0,
  manual: 2,
};
const handlers = (connected: boolean, extra: Parameters<typeof renderApp>[1] = {}) => ({
  session: 'admin' as const,
  handlers: {
    '/api/v1/users': () => json({ items: [user], nextCursor: null }),
    '/api/v1/platform/idp': () =>
      connected ? json(status(true)) : problem(503, 'IDP_UNAVAILABLE', 'Not connected.'),
    '/api/v1/platform/idp/groups': () => json({ items: [group], nextCursor: null }),
    ...extra.handlers,
  },
});

describe('platform Invite wizard', () => {
  it('is hidden while the binding is absent', async () => {
    await renderApp('/admin/users', handlers(false));
    expect(await screen.findByRole('link', { name: /Ada Lovelace/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
  });

  it('sends groups and developer access, and shows the link once on Done', async () => {
    const bodies: unknown[] = [];
    await renderApp(
      '/admin/users',
      handlers(true, {
        handlers: {
          '/api/v1/platform/invitations': (_u: URL, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body)));
            return json(
              {
                id: 'pi1',
                email: 'new@example.com',
                groups: ['staff'],
                developer: false,
                state: 'pending',
                createdAt: 1,
                expiresAt: 2,
                acceptedAt: null,
                revokedAt: null,
                link: 'https://wallet.test/invite#p_secret',
              },
              201,
            );
          },
        },
      }),
    );
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Invite' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite to Polaris ID' });
    expect((await axe(dialog)).violations).toEqual([]);
    await ui.type(within(dialog).getByLabelText('Emails'), 'new@example.com,');
    await ui.click(within(dialog).getByRole('button', { name: 'Next' }));
    await ui.click(await within(dialog).findByRole('checkbox', { name: 'Staff' }));
    await ui.click(within(dialog).getByRole('button', { name: 'Next' }));
    await ui.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    await waitFor(() =>
      expect(bodies).toEqual([{ email: 'new@example.com', groups: ['staff'], developer: false }]),
    );
    expect(await screen.findByText('Invitation sent to n•••@example.com.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });

  it('needs a group or developer access', async () => {
    await renderApp('/admin/users', handlers(true));
    const ui = userEvent.setup();
    await ui.click(await screen.findByRole('button', { name: 'Invite' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite to Polaris ID' });
    await ui.type(within(dialog).getByLabelText('Emails'), 'new@example.com,');
    await ui.click(within(dialog).getByRole('button', { name: 'Next' }));
    await ui.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(
      await within(dialog).findByText('Choose a group or developer access.'),
    ).toBeInTheDocument();
  });
});
