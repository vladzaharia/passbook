import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { eligibleTemplateFixture, pairingFixture, scannerFixture } from '../test-fixtures.ts';
import { managedSession } from './test-fixtures.ts';

const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const harbor = membershipFixture('o2', { orgName: 'Harbor', orgSlug: 'harbor' });

function setup() {
  let session = structuredClone(managedSession);
  let saved: Record<string, unknown> | undefined;
  let failed = false;
  const handlers = {
    '/api/v1/scan-setups': () => json({ items: [], nextCursor: null }),
    '/api/v1/templates/eligible': () => json({ items: [], nextCursor: null }),
    '/api/v1/scan-events': () => json({ items: [], nextCursor: null }),
    '/api/v1/scanning-sessions': (_url: URL, init?: RequestInit) => {
      if (init?.method !== 'POST') return json({ items: [session], nextCursor: null });
      saved = JSON.parse(String(init.body));
      return json({ ...session, ...saved }, 201);
    },
    '/api/v1/scanning-sessions/session-1': (_url: URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        if (failed) return problem(409, 'SCANNING_SESSION_CHANGED', 'Reload session settings.');
        saved = JSON.parse(String(init.body));
        session = { ...session, ...saved, updatedAt: session.updatedAt + 1 };
      }
      return json(session);
    },
    '/api/v1/scanning-sessions/session-1/devices': (_url: URL, init?: RequestInit) => {
      saved = JSON.parse(String(init?.body));
      return json(
        {
          ...session.devices[0],
          ...saved,
          id: 'new-device',
          signIn: 'paired',
          pairing: pairingFixture(),
        },
        201,
      );
    },
    '/api/v1/scan-setups/new-device': () =>
      json(scannerFixture({ id: 'new-device', status: 'not_paired', pairedAt: null })),
    '/api/v1/scanning-sessions/session-1/devices/device-1': (_url: URL, init?: RequestInit) => {
      saved = JSON.parse(String(init?.body));
      return json({ ...session.devices[0], ...saved, updatedAt: session.updatedAt + 1 });
    },
  };
  return {
    handlers,
    saved: () => saved,
    fail: () => {
      failed = true;
    },
  };
}

describe('session configuration flows', () => {
  it('keeps the session picker open and clears tenant-specific selections when it changes scope', async () => {
    const s = setup();
    const { router } = await renderApp('/admin/scanning?orgId=o1', {
      session: 'admin',
      memberships: [northwind, harbor],
      selectedOrg: 'o1',
      handlers: {
        ...s.handlers,
        '/api/v1/templates/eligible': () =>
          json({
            items: [
              eligibleTemplateFixture(),
              eligibleTemplateFixture({
                templateId: 't2',
                templateOrgId: 'o2',
                name: 'Harbor ticket',
              }),
            ],
            nextCursor: null,
          }),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New scanning session' }));
    const dialog = screen.getByRole('dialog', { name: 'New scanning session' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Session name' }), 'Entry');
    await user.click(within(dialog).getByRole('radio', { name: 'Templates' }));
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Gala ticket' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'Organization' }));
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    await waitFor(() => expect(router.state.location.search.orgId).toBe('o2'));
    expect(screen.getByRole('dialog', { name: 'New scanning session' })).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Session name' })).toHaveValue('Entry');
    expect(within(dialog).queryByRole('checkbox', { name: 'Gala ticket' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create session' })).toBeDisabled();
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Harbor ticket' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    await waitFor(() =>
      expect(s.saved()).toMatchObject({
        orgId: 'o2',
        name: 'Entry',
        accepts: { templateIds: ['t2'] },
      }),
    );
  });

  it('keeps duplicate creation available after choosing another manageable organization', async () => {
    const s = setup();
    const { router } = await renderApp('/admin/scanning/sessions/session-1?orgId=o1', {
      session: 'admin',
      memberships: [northwind, harbor],
      selectedOrg: 'o1',
      handlers: s.handlers,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate session' }));
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate session' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Organization' }));
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    await waitFor(() => expect(router.state.location.search.orgId).toBe('o2'));
    expect(await within(dialog).findByRole('textbox', { name: 'Session name' })).toHaveValue(
      'Membership desk copy',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    await waitFor(() =>
      expect(s.saved()).toMatchObject({ orgId: 'o2', name: 'Membership desk copy' }),
    );
  });

  it('uses approved owned and shared releases for session template selection', async () => {
    const s = setup();
    const requests: URL[] = [];
    const { fetchMock } = await renderApp('/admin/scanning?orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...s.handlers,
        '/api/v1/templates/eligible': (url) => {
          requests.push(url);
          if (url.searchParams.get('cursor') === 'next') {
            return json({
              items: [
                eligibleTemplateFixture({
                  templateId: 'shared',
                  templateOrgId: null,
                  origin: 'baked',
                  name: 'Shared approved',
                }),
              ],
              nextCursor: null,
            });
          }
          return json({
            items: [
              eligibleTemplateFixture(),
              eligibleTemplateFixture({
                templateId: 'foreign',
                templateOrgId: 'o2',
                name: 'Foreign release',
              }),
              eligibleTemplateFixture({
                templateId: 'value',
                name: 'Value only',
                supportsCheckIn: false,
              }),
            ],
            nextCursor: 'next',
          });
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New scanning session' }));
    const dialog = screen.getByRole('dialog', { name: 'New scanning session' });
    await user.click(within(dialog).getByRole('radio', { name: 'Templates' }));
    expect(
      await within(dialog).findByRole('checkbox', { name: 'Gala ticket' }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Load more templates' }));
    expect(
      await within(dialog).findByRole('checkbox', { name: 'Shared approved' }),
    ).toBeInTheDocument();
    expect(requests[1]?.searchParams.get('cursor')).toBe('next');
    expect(within(dialog).getByRole('checkbox', { name: 'Value only' })).toBeInTheDocument();
    expect(within(dialog).queryByText('Foreign release')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/templates?'))).toBe(
      false,
    );
    expect(Object.fromEntries(requests[0]!.searchParams)).toMatchObject({
      orgId: 'o1',
      mode: 'live',
      provider: 'apple',
    });
  });

  it('creates shared admission and input defaults from the session form', async () => {
    const s = setup();
    await renderApp('/admin/scanning?orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: s.handlers,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New scanning session' }));
    const dialog = screen.getByRole('dialog', { name: 'New scanning session' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Session name' }), 'Evening entry');
    await user.click(within(dialog).getByRole('tab', { name: 'Admission' }));
    expect(within(dialog).getByText('Staff access')).toBeInTheDocument();
    const staffSignIn = within(dialog).getByRole('switch', { name: 'Require staff sign-in' });
    expect(staffSignIn).toHaveAccessibleDescription(
      /Bearer-token terminals do not use staff PINs and always use the access level below/i,
    );
    expect(within(dialog).getByText(/Admin-as-scanner sessions use/i)).toHaveTextContent(
      'the signed-in administrator’s Manager permissions',
    );
    await user.click(staffSignIn);
    await user.click(within(dialog).getByRole('combobox', { name: 'Check-in type' }));
    await user.click(screen.getByRole('option', { name: 'Track in / out' }));
    await user.click(within(dialog).getByRole('tab', { name: 'Device defaults' }));
    await user.click(
      within(dialog).getByRole('combobox', { name: 'On scan, tap or entered code' }),
    );
    await user.click(screen.getByRole('option', { name: 'Review before check-in' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    await waitFor(() =>
      expect(s.saved()).toMatchObject({
        name: 'Evening entry',
        orgId: 'o1',
        accepts: null,
        settings: {
          flow: 'choose',
          checkIn: { mode: 'in_out' },
          staffSignIn: true,
          roleWithoutSignIn: 'door',
        },
      }),
    );
  });
  it('keeps a failed settings draft and submits its revision when retrying', async () => {
    const s = setup();
    s.fail();
    await renderApp('/admin/scanning/sessions/session-1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: s.handlers,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Session rules' });
    const name = within(dialog).getByRole('textbox', { name: 'Session name' });
    await user.clear(name);
    await user.type(name, 'Updated entry');
    await user.click(within(dialog).getByRole('button', { name: 'Save session' }));
    expect(await within(dialog).findByText('Reload session settings.')).toBeInTheDocument();
    expect(name).toHaveValue('Updated entry');
    await user.click(within(dialog).getByRole('button', { name: 'Reload settings' }));
    expect(name).toHaveValue(managedSession.name);
  });
  it('adds a customer display with its own pairing code', async () => {
    const s = setup();
    await renderApp('/admin/scanning/sessions/session-1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: s.handlers,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add device' }));
    const dialog = screen.getByRole('dialog', { name: 'Add device' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Device name' }), 'Visitor phone');
    const automatic = within(dialog).getByRole('button', { name: /^Automatic/ });
    expect(automatic).toHaveAttribute('aria-pressed', 'true');
    expect(automatic).toHaveTextContent('Scanner or Operator');
    expect(within(dialog).getByText('CHECK-IN')).toBeInTheDocument();
    expect(within(dialog).getByText('CUSTOMER DISPLAY')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^Customer display/ }));
    expect(within(dialog).getByRole('button', { name: /^Customer display/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create pairing code' }));
    expect(await screen.findByRole('dialog', { name: 'Pair Visitor phone' })).toBeInTheDocument();
    expect(s.saved()).toMatchObject({ name: 'Visitor phone', surface: 'customer' });
  });
  it('saves a device override without changing the shared admission policy', async () => {
    const s = setup();
    await renderApp('/admin/scanning/sessions/session-1?deviceId=device-1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: s.handlers,
    });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Configure Admin phone' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Direction' }));
    await user.click(screen.getByRole('option', { name: 'Exit only' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'Look up people' }));
    await user.click(screen.getByRole('option', { name: 'Off' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save device' }));
    await waitFor(() =>
      expect(s.saved()).toMatchObject({
        revision: managedSession.updatedAt,
        overrides: { direction: 'out', lookup: false },
      }),
    );
    expect(s.saved()).not.toHaveProperty('settings');
  });
});
