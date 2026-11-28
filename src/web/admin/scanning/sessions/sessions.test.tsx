import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { pairingFixture, scannerFixture } from '../test-fixtures.ts';

import { SessionSummary } from './session-summary.tsx';
import { managedSession as session } from './test-fixtures.ts';

const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const harbor = membershipFixture('o2', { orgName: 'Harbor', orgSlug: 'harbor' });
const handlers = {
  '/api/v1/scanning-sessions/session-1': () => json(session),
  '/api/v1/scanning-sessions': () => json({ items: [session], nextCursor: null }),
  '/api/v1/scan-setups': () => json({ items: [], nextCursor: null }),
};

describe('session administration', () => {
  it('canonicalizes an unscoped session link to its authorized organization', async () => {
    const previous = localStorage.getItem('wallet-org-filter');
    localStorage.setItem('wallet-org-filter', 'o1');
    try {
      const { router } = await renderApp('/admin/scanning/sessions/session-1', {
        session: 'admin',
        memberships: [northwind, harbor],
        handlers: {
          ...handlers,
          '/api/v1/scanning-sessions/session-1': () =>
            json({ ...session, orgId: 'o2', orgName: 'Harbor', name: 'Harbor desk' }),
        },
      });
      expect(
        await screen.findByRole('heading', { name: 'Harbor desk', level: 1 }),
      ).toBeInTheDocument();
      await waitFor(() => expect(router.state.location.pathname.split('/')[3]).toBe('o2'));
    } finally {
      if (previous === null) localStorage.removeItem('wallet-org-filter');
      else localStorage.setItem('wallet-org-filter', previous);
    }
  });

  it('keeps session and device details readable without management actions', async () => {
    await renderApp('/admin/scanning/sessions/session-1?deviceId=device-1&addDevice=1', {
      session: 'admin',
      memberships: [membershipFixture('o1', { capabilities: ['org:read', 'scanning:read'] })],
      selectedOrg: 'o1',
      handlers,
    });
    const sheet = await screen.findByRole('dialog', { name: 'Device Admin phone' });
    expect(within(sheet).getByLabelText(/^Device name/)).toBeDisabled();
    expect(within(sheet).getByRole('button', { name: /^Console/ })).toBeDisabled();
    expect(within(sheet).queryByRole('button', { name: 'Save device' })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /Pair/ })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Revoke device' })).not.toBeInTheDocument();
    await userEvent.setup().click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(
      await screen.findByRole('heading', { name: 'Membership desk', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'More rules' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add device' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Scan as Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Add device' })).not.toBeInTheDocument();
  });

  it('shows shared rules, devices and activity with an accessible layout', async () => {
    const { container } = await renderApp('/admin/scanning/sessions/session-1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers,
    });
    expect(
      await screen.findByRole('heading', { name: 'Membership desk', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'More rules' })).toBeInTheDocument();
    expect(screen.getByTestId('session-device')).toHaveTextContent('Admin phone');
    expect(screen.getByTestId('session-device')).toHaveTextContent('390 × 844');
    expect(screen.getByText('In and out, no zone')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });
  it('hides a session from another selected organization, including deep-linked device actions', async () => {
    const unexpected: string[] = [];
    let loaded = 0;
    await renderApp('/admin/scanning/sessions/session-1?deviceId=device-1&addDevice=1', {
      session: 'admin',
      memberships: [northwind, harbor],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/scanning-sessions/session-1': () => {
          loaded += 1;
          return json({ ...session, orgId: 'o2', orgName: 'Harbor', name: 'Private session' });
        },
        '/api/v1/scan-setups/device-1': () => {
          unexpected.push('scanner');
          return json(scannerFixture({ id: 'device-1', orgId: 'o2' }));
        },
        '/api/v1/scanners/device-1/pairing': () => {
          unexpected.push('pairing');
          return json({});
        },
        '/api/v1/scanning-sessions/session-1/devices': () => {
          unexpected.push('add device');
          return json({});
        },
      },
    });
    expect(await screen.findByText('Scanner not found')).toBeInTheDocument();
    expect(loaded).toBeGreaterThan(0);
    expect(screen.queryByText('Private session')).not.toBeInTheDocument();
    expect(screen.queryByText('Admin phone')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add device' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Scan as Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(unexpected).toEqual([]);
  });

  it('closes an open device sheet and hides cached session details on an organization switch', async () => {
    const { router, queryClient } = await renderApp(
      '/admin/scanning/sessions/session-1?deviceId=device-1',
      {
        session: 'admin',
        memberships: [northwind, harbor],
        selectedOrg: 'o1',
        handlers,
      },
    );
    expect(
      await screen.findByRole('dialog', { name: 'Configure Admin phone' }),
    ).toBeInTheDocument();
    await act(async () => {
      await router.navigate({
        to: '/admin/scanning/sessions/$sessionId',
        params: { sessionId: 'session-1' },
        search: { orgId: 'o2', deviceId: 'device-1' },
      });
    });
    expect(await screen.findByText('Scanner not found')).toBeInTheDocument();
    expect(
      queryClient.getQueryData(['admin', 'scanning', 'sessions', 'detail', 'session-1']),
    ).toMatchObject({
      orgId: 'o1',
    });
    expect(screen.queryByText('Membership desk')).not.toBeInTheDocument();
    expect(screen.queryByText('Admin phone')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add device' })).not.toBeInTheDocument();

    await act(async () => {
      await router.navigate({
        to: '/admin/scanning/sessions/$sessionId',
        params: { sessionId: 'session-1' },
        search: { orgId: 'o1' },
      });
    });
    expect(
      await screen.findByRole('heading', { name: 'Membership desk', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not mount pairing for a loaded scanner belonging to another organization', async () => {
    const pairing: string[] = [];
    let loaded = 0;
    await renderApp('/admin/scanning/sessions/session-1?deviceId=device-1', {
      session: 'admin',
      memberships: [northwind, harbor],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/scanning-sessions/session-1': () =>
          json({
            ...session,
            devices: session.devices.map((device) => ({
              ...device,
              signIn: 'paired',
              paired: false,
            })),
          }),
        '/api/v1/scan-setups/device-1': () => {
          loaded += 1;
          return json(
            scannerFixture({
              id: 'device-1',
              orgId: 'o2',
              name: 'Foreign device',
              status: 'not_paired',
            }),
          );
        },
        '/api/v1/scanners/device-1/pairing': (url) => {
          pairing.push(url.pathname);
          return json({});
        },
      },
    });
    const user = userEvent.setup();
    const sheet = await screen.findByRole('dialog', { name: 'Configure Admin phone' });
    await user.click(within(sheet).getByRole('button', { name: 'Pair device' }));
    expect(await screen.findByRole('dialog', { name: 'Scanner not found' })).toBeInTheDocument();
    expect(loaded).toBeGreaterThan(0);
    expect(screen.queryByText('Foreign device')).not.toBeInTheDocument();
    expect(pairing).toEqual([]);
  });

  it.each([
    { orgId: 'o2', sessionId: 'session-1' },
    { orgId: 'o1', sessionId: 'another-session' },
  ])('revalidates a cached device before pairing for $orgId / $sessionId', async (actual) => {
    let answer!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    let loaded = 0;
    const pairing: string[] = [];
    const { queryClient } = await renderApp(
      '/admin/scanning/sessions/session-1?deviceId=device-1',
      {
        session: 'admin',
        memberships: [northwind, harbor],
        selectedOrg: 'o1',
        handlers: {
          ...handlers,
          '/api/v1/scanning-sessions/session-1': () =>
            json({
              ...session,
              devices: session.devices.map((device) => ({
                ...device,
                signIn: 'paired',
                paired: false,
              })),
            }),
          '/api/v1/scan-setups/device-1': () => {
            loaded += 1;
            return response;
          },
          '/api/v1/scanners/device-1/pairing': (url) => {
            pairing.push(url.pathname);
            return json({});
          },
        },
      },
    );
    const sheet = await screen.findByRole('dialog', { name: 'Configure Admin phone' });
    queryClient.setQueryData(
      ['admin', 'scanning', 'scanners', 'detail', 'device-1'],
      scannerFixture({ id: 'device-1', orgId: 'o1', sessionId: 'session-1', status: 'not_paired' }),
    );
    await userEvent.setup().click(within(sheet).getByRole('button', { name: 'Pair device' }));
    await waitFor(() => expect(loaded).toBeGreaterThan(0));
    expect(pairing).toEqual([]);
    expect(screen.queryByRole('dialog', { name: /Pair Front door/ })).not.toBeInTheDocument();
    await act(async () => {
      answer(json(scannerFixture({ id: 'device-1', ...actual, status: 'not_paired' })));
    });
    expect(await screen.findByRole('dialog', { name: 'Scanner not found' })).toBeInTheDocument();
    expect(pairing).toEqual([]);
  });

  it('pairs a freshly verified device belonging to the session', async () => {
    let creates = 0;
    await renderApp('/admin/scanning/sessions/session-1?deviceId=device-1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/scanning-sessions/session-1': () =>
          json({
            ...session,
            devices: session.devices.map((device) => ({
              ...device,
              signIn: 'paired',
              paired: false,
            })),
          }),
        '/api/v1/scan-setups/device-1': () =>
          json(
            scannerFixture({
              id: 'device-1',
              orgId: 'o1',
              sessionId: 'session-1',
              status: 'not_paired',
            }),
          ),
        '/api/v1/scanners/device-1/pairing': (_url, init) => {
          if (init?.method === 'POST') {
            creates += 1;
            return json(pairingFixture());
          }
          return json({ state: 'waiting', device: null });
        },
      },
    });
    const sheet = await screen.findByRole('dialog', { name: 'Configure Admin phone' });
    await userEvent.setup().click(within(sheet).getByRole('button', { name: 'Pair device' }));
    expect(await screen.findByRole('dialog', { name: /Pair Front door/ })).toBeInTheDocument();
    await waitFor(() => expect(creates).toBe(1));
  });

  it.each([
    { lookup: true, photo: undefined, offline: 'stop', rows: ['Stop', 'On', 'On'] },
    { lookup: false, photo: false, offline: 'list', rows: ['Offline list', 'Off', 'Off'] },
  ] as const)(
    'summarises the rules the setup rows leave out',
    ({ lookup, photo, offline, rows }) => {
      render(
        <SessionSummary
          session={{
            ...session,
            settings: {
              ...session.settings,
              lookup,
              whenOffline: offline,
              ...(photo === undefined ? {} : { showPhoto: photo }),
            },
          }}
          onEdit={vi.fn()}
        />,
      );
      for (const [label, value] of [
        ['Offline', rows[0]],
        ['Lookup', rows[1]],
        ['Photos', rows[2]],
      ] as const)
        expect(screen.getByText(label).parentElement).toHaveTextContent(value);
      expect(screen.getByText('Time zone')).toBeInTheDocument();
    },
  );
  it('allows the operator layout on a phone and protects unsaved device settings', async () => {
    await renderApp('/admin/scanning/sessions/session-1?deviceId=device-1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers,
    });
    const dialog = await screen.findByRole('dialog', { name: 'Configure Admin phone' });
    expect(within(dialog).getByText('iPhone/iPad')).toBeInTheDocument();
    expect(within(dialog).getByText('NDEF tag input')).toBeInTheDocument();
    expect(within(dialog).getByText('Wallet pass reader unavailable')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^Console/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /^Handheld/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /Customer screen/ })).toBeEnabled();
    expect(within(dialog).queryByRole('button', { name: /Desk display/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Pair/ })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(within(dialog).getByRole('textbox', { name: 'Device name' }), ' updated');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(within(dialog).getByRole('textbox', { name: 'Device name' })).toHaveValue(
      'Admin phone updated',
    );
  });
  it('opens the view picker after creating a session from Devices', async () => {
    await renderApp('/admin/scanning/sessions/session-1?addDevice=1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers,
    });
    const dialog = await screen.findByRole('dialog', { name: 'Add device' });
    expect(within(dialog).getByRole('button', { name: /^Handheld/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /^Console/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /^Customer screen/ })).toBeEnabled();
    expect(within(dialog).queryByRole('button', { name: /Desk display/ })).not.toBeInTheDocument();
  });
});
