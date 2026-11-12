import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { managedSession } from '../sessions/test-fixtures.ts';
import { eligibleTemplateFixture, scannerFixture as s, templateFixture } from '../test-fixtures.ts';

const page = (items: unknown[]) => json({ items, nextCursor: null });
const none = () => page([]);
const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const harbor = membershipFixture('o2', { orgName: 'Harbor', orgSlug: 'harbor' });
const base = {
  '/api/v1/scan-events': none,
  '/api/v1/templates': () => page([templateFixture()]),
  '/api/v1/templates/eligible': () => page([eligibleTemplateFixture()]),
};

afterEach(() => resetModeForTests());

describe('Scanner page', () => {
  it('canonicalizes an unscoped scanner link to its authorized organization', async () => {
    const previous = localStorage.getItem('wallet-org-filter');
    localStorage.setItem('wallet-org-filter', 'o1');
    try {
      const seen: (string | null)[] = [];
      const { router } = await renderApp('/admin/scanning/scanners/s1', {
        session: 'admin',
        memberships: [northwind, harbor],
        handlers: {
          '/api/v1/scan-setups/s1': () => json(s({ orgId: 'o2', name: 'Harbor scanner' })),
          '/api/v1/scan-events': (url) => {
            seen.push(url.searchParams.get('orgId'));
            return none();
          },
          '/api/v1/templates': (url) => {
            seen.push(url.searchParams.get('orgId'));
            return none();
          },
          '/api/v1/templates/eligible': (url) => {
            seen.push(url.searchParams.get('orgId'));
            return page([eligibleTemplateFixture({ templateOrgId: 'o2' })]);
          },
        },
      });
      expect(
        await screen.findByRole('heading', { name: 'Harbor scanner', level: 1 }),
      ).toBeInTheDocument();
      await waitFor(() => expect(router.state.location.search.orgId).toBe('o2'));
      await waitFor(() => expect(seen).toContain('o2'));
      expect(seen.every((id) => id === 'o2')).toBe(true);
    } finally {
      if (previous === null) localStorage.removeItem('wallet-org-filter');
      else localStorage.setItem('wallet-org-filter', previous);
    }
  });

  it('shows scanner settings read-only without scanning management permission', async () => {
    await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [membershipFixture('o1', { capabilities: ['org:read', 'scanning:read'] })],
      selectedOrg: 'o1',
      handlers: { ...base, '/api/v1/scan-setups/s1': () => json(s()) },
    });
    expect(
      await screen.findByRole('heading', { name: 'Front door', level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText(/^Name/)).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Device' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pair again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
  });

  it('offers only approved owned and shared releases when configuring accepted templates', async () => {
    const requests: URL[] = [];
    const { fetchMock } = await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind, harbor],
      selectedOrg: 'o1',
      handlers: {
        ...base,
        '/api/v1/scan-setups/s1': () => json(s()),
        '/api/v1/templates': () => page([templateFixture({ name: 'Unreleased draft' })]),
        '/api/v1/templates/eligible': (url) => {
          requests.push(url);
          if (url.searchParams.get('cursor') === 'next') {
            return page([
              eligibleTemplateFixture({
                templateId: 'shared',
                templateOrgId: null,
                origin: 'baked',
                name: 'Shared approved',
              }),
            ]);
          }
          return json({
            items: [
              eligibleTemplateFixture(),
              eligibleTemplateFixture({
                templateId: 'foreign',
                templateOrgId: 'o2',
                name: 'Foreign release',
              }),
            ],
            nextCursor: 'next',
          });
        },
      },
    });
    expect(await screen.findByRole('checkbox', { name: 'Gala ticket' })).toBeChecked();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load more templates' }));
    expect(await screen.findByRole('checkbox', { name: 'Shared approved' })).toBeInTheDocument();
    expect(requests[1]?.searchParams.get('cursor')).toBe('next');
    expect(screen.queryByText('Foreign release')).not.toBeInTheDocument();
    expect(screen.queryByText('Unreleased draft')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/templates?'))).toBe(
      false,
    );
    expect(Object.fromEntries(requests[0]!.searchParams)).toMatchObject({
      orgId: 'o1',
      mode: 'live',
      provider: 'apple',
    });
  });

  it('closes a pairing confirmation if management capability is removed', async () => {
    const { queryClient } = await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: { ...base, '/api/v1/scan-setups/s1': () => json(s()) },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Pair again' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Pair Front door again?' }),
    ).toBeInTheDocument();
    act(() => {
      queryClient.setQueryData(['org-memberships', 'me'], {
        items: [{ ...northwind, capabilities: ['org:read', 'scanning:read'] }],
      });
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(await screen.findByLabelText(/^Name/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Pair again' })).not.toBeInTheDocument();
  });

  it('shows status, device and settings in a two-pane page', async () => {
    const { container, router } = await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...base,
        '/api/v1/scan-setups': none,
        '/api/v1/scanning-sessions': none,
        '/api/v1/scan-setups/s1': () => json(s()),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Front door', level: 1 }),
    ).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const scanning = within(crumbs).getByRole('link', { name: 'Scanning' });
    expect(new URL(scanning.getAttribute('href') ?? '', 'https://wallet.test').pathname).toBe(
      '/admin/scanning',
    );
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Scans' }).getAttribute('href')).toContain('tab=scans');
    expect(screen.getByRole('link', { name: 'Scans' }).getAttribute('href')).toContain(
      'scannerId=s1',
    );
    expect(screen.getByRole('button', { name: 'Pair again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go live' })).toBeNull();
    const device = screen.getByRole('heading', { name: 'Device' }).closest('div');
    expect(device?.parentElement).toHaveTextContent('Safari on iPhone');
    expect((await axe(container)).violations).toEqual([]);
    await userEvent.setup().click(scanning);
    await waitFor(() =>
      expect(router.state.location).toMatchObject({
        pathname: '/admin/scanning',
        search: { orgId: 'o1' },
      }),
    );
  });

  it('saves changed settings through the SaveBar', async () => {
    let patch: Record<string, unknown> | undefined;
    await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...base,
        '/api/v1/scan-setups/s1': (_u, init) => {
          if (init?.method === 'PATCH') {
            patch = JSON.parse(String(init.body));
            return new Response(null, { status: 204 });
          }
          return json(s());
        },
      },
    });
    const user = userEvent.setup();
    const name = await screen.findByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, 'Main door');
    await user.click(await screen.findByRole('button', { name: /Save/ }));
    await waitFor(() => expect(patch).toMatchObject({ name: 'Main door' }));
    expect(patch?.settings).toMatchObject({ flow: 'auto', letInAgain: 'anyone' });
  });

  it('enables staff PIN sign-in and explains the organization-wide accounts', async () => {
    let patch: Record<string, unknown> | undefined;
    await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...base,
        '/api/v1/scan-setups/s1': (_u, init) => {
          if (init?.method === 'PATCH') {
            patch = JSON.parse(String(init.body));
            return new Response(null, { status: 204 });
          }
          return json(s());
        },
      },
    });
    const user = userEvent.setup();
    const toggle = await screen.findByRole('checkbox', { name: 'Ask staff for their PIN' });
    expect(toggle).toBeEnabled();
    expect(
      screen.getByText(/shared across this organization’s live and test modes/i),
    ).toBeVisible();
    await user.click(toggle);
    await user.click(await screen.findByRole('button', { name: /Save/ }));
    await waitFor(() => expect(patch?.settings).toMatchObject({ staffSignIn: true }));
  });

  it('shows that a till uses its configured role rather than staff PIN sign-in', async () => {
    const terminal = s({ kind: 'terminal', pairedLabel: null });
    terminal.settings.staffSignIn = true;
    await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: { ...base, '/api/v1/scan-setups/s1': () => json(terminal) },
    });
    expect(await screen.findByText(/Tills do not support staff PIN sign-in/)).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: 'Ask staff for their PIN' })).toBeNull();
    expect(screen.getByLabelText('Without sign-in, scans as')).toBeInTheDocument();
  });

  it('shows that an admin-as-scanner uses the administrator rather than a staff PIN', async () => {
    await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...base,
        '/api/v1/scan-setups/s1': () =>
          json(s({ adminSession: true, adminUser: { id: 'u1', name: 'Admin' } })),
      },
    });
    expect(await screen.findByText(/This admin-as-scanner setup uses/i)).toHaveTextContent(
      'the signed-in administrator’s Manager permissions, not a staff PIN',
    );
    expect(screen.queryByRole('checkbox', { name: 'Ask staff for their PIN' })).toBeNull();
    expect(screen.queryByLabelText('Without sign-in, scans as')).toBeNull();
  });

  it('goes live from a Test scanner after a confirm that names what changes', async () => {
    let live = false;
    const { fetchMock } = await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...base,
        '/api/v1/scan-setups/s1': () => json(s({ mode: 'test' })),
        '/api/v1/scanners/s1/mode': (_u, init) => {
          live = JSON.parse(String(init?.body)).mode === 'live';
          return new Response(null, { status: 204 });
        },
      },
    });
    expect(
      await screen.findByText('Switch to Test mode to edit scanner settings.'),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText(/^Name/)).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/templates/eligible')),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/scan-events?')),
    ).toBe(false);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Go live' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Make Front door live?' });
    expect(dialog).toHaveTextContent(
      'It starts accepting live passes and stops accepting test ones.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Go live' }));
    await waitFor(() => expect(live).toBe(true));
  });

  it('shows a till token once and gates Done on "I saved the token"', async () => {
    await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...base,
        '/api/v1/scan-setups/s1': () => json(s({ kind: 'terminal', pairedLabel: null })),
        '/api/v1/scanners/s1/token': () =>
          json({ token: 'wls_ab12cd34_secretsecretsecret', expiresAt: Date.now() + 1e9 }),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Replace token' }));
    const dialog = await screen.findByRole('dialog', { name: /token/ });
    expect(
      await within(dialog).findByText('Copy the secret now. It is not shown again.'),
    ).toBeInTheDocument();
    const done = within(dialog).getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: 'I saved the token' }));
    await user.click(done);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText(/wls_ab12cd34/)).toBeNull();
  });

  it('keeps a revoked scanner read-only', async () => {
    await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: { ...base, '/api/v1/scan-setups/s1': () => json(s({ status: 'revoked' })) },
    });
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pair again' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(await screen.findByLabelText(/^Name/)).toBeDisabled();
  });
  it('redirects a selected organization’s session device to its session', async () => {
    const { router } = await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...base,
        '/api/v1/scan-setups/s1': () => json(s({ sessionId: 'session-1' })),
        '/api/v1/scanning-sessions/session-1': () => json(managedSession),
      },
    });
    await waitFor(() =>
      expect(router.state.location).toMatchObject({
        pathname: '/admin/scanning/sessions/session-1',
        search: { orgId: 'o1', deviceId: 's1' },
      }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Membership desk', level: 1 }),
    ).toBeInTheDocument();
  });

  it('does not show, redirect, or start dependent requests for another organization’s scanner', async () => {
    const unexpected: string[] = [];
    let loaded = 0;
    const { router } = await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind, harbor],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/scan-setups/s1': () => {
          loaded += 1;
          return json(
            s({
              orgId: 'o2',
              name: 'Harbor scanner',
              accepts: { eventId: 'private-event' },
              sessionId: 'private-session',
            }),
          );
        },
        '/api/v1/scan-events': () => {
          unexpected.push('events');
          return none();
        },
        '/api/v1/templates': () => {
          unexpected.push('templates');
          return none();
        },
        '/api/v1/templates/eligible': () => {
          unexpected.push('eligible templates');
          return none();
        },
        '/api/v1/scanning-sessions/private-session': () => {
          unexpected.push('session');
          return none();
        },
        '/api/v1/scanners/s1/pairing': () => {
          unexpected.push('pairing');
          return none();
        },
      },
    });
    expect(await screen.findByText('Scanner not found')).toBeInTheDocument();
    expect(loaded).toBeGreaterThan(0);
    expect(screen.queryByText('Harbor scanner')).not.toBeInTheDocument();
    expect(screen.queryByText('Safari on iPhone')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pair again' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Name/)).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/scanning/scanners/s1');
    expect(unexpected).toEqual([]);
  });

  it('unmounts a pairing confirmation when the selected organization changes', async () => {
    const pairing: string[] = [];
    const { router, queryClient } = await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind, harbor],
      selectedOrg: 'o1',
      handlers: {
        ...base,
        '/api/v1/scan-setups/s1': () => json(s()),
        '/api/v1/scanners/s1/pairing': (url) => {
          pairing.push(url.pathname);
          return none();
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pair again' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Pair Front door again?' }),
    ).toBeInTheDocument();

    await act(async () => {
      await router.navigate({
        to: '/admin/scanning/scanners/$scannerId',
        params: { scannerId: 's1' },
        search: { orgId: 'o2' },
      });
    });
    expect(await screen.findByText('Scanner not found')).toBeInTheDocument();
    expect(
      queryClient.getQueryData(['admin', 'scanning', 'scanners', 'detail', 's1']),
    ).toMatchObject({
      orgId: 'o1',
    });
    expect(screen.queryByText('Front door')).not.toBeInTheDocument();
    expect(screen.queryByText('Safari on iPhone')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pair again' })).not.toBeInTheDocument();
    expect(pairing).toEqual([]);

    await act(async () => {
      await router.navigate({
        to: '/admin/scanning/scanners/$scannerId',
        params: { scannerId: 's1' },
        search: { orgId: 'o1' },
      });
    });
    expect(
      await screen.findByRole('heading', { name: 'Front door', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows not found for a scanner that is not there', async () => {
    await renderApp('/admin/scanning/scanners/nope', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...base,
        '/api/v1/scan-setups/nope': () => problem(404, 'not_found', 'No scanner.'),
      },
    });
    expect(await screen.findByText(/scanner/i, { selector: 'h1, h2, p' })).toBeInTheDocument();
  });
});
