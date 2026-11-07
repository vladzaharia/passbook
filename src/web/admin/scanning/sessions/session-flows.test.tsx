import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { pairingFixture, scannerFixture } from '../test-fixtures.ts';
import { managedSession } from './test-fixtures.ts';

function setup() {
  let session = structuredClone(managedSession);
  let saved: Record<string, unknown> | undefined;
  let failed = false;
  const handlers = {
    '/api/v1/scan-setups': () => json({ items: [], nextCursor: null }),
    '/api/v1/templates': () => json({ items: [], nextCursor: null }),
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
  it('creates shared admission and input defaults from the session form', async () => {
    const s = setup();
    await renderApp('/admin/scanning?orgId=o1', { session: 'admin', handlers: s.handlers });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New scanning session' }));
    const dialog = screen.getByRole('dialog', { name: 'New scanning session' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Session name' }), 'Evening entry');
    await user.click(within(dialog).getByRole('tab', { name: 'Admission' }));
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
        settings: { flow: 'choose', checkIn: { mode: 'in_out' } },
      }),
    );
  });
  it('keeps a failed settings draft and submits its revision when retrying', async () => {
    const s = setup();
    s.fail();
    await renderApp('/admin/scanning/sessions/session-1', {
      session: 'admin',
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
      handlers: s.handlers,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add device' }));
    const dialog = screen.getByRole('dialog', { name: 'Add device' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Device name' }), 'Visitor phone');
    await user.click(within(dialog).getByRole('button', { name: /^Customer display/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create pairing code' }));
    expect(await screen.findByRole('dialog', { name: 'Pair Visitor phone' })).toBeInTheDocument();
    expect(s.saved()).toMatchObject({ name: 'Visitor phone', surface: 'customer' });
  });
  it('saves a device override without changing the shared admission policy', async () => {
    const s = setup();
    await renderApp('/admin/scanning/sessions/session-1?deviceId=device-1', {
      session: 'admin',
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
