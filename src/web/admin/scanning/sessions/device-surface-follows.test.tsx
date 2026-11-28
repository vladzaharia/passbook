import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { managedSession } from './test-fixtures.ts';

describe('device sheet follows', () => {
  it('keeps follows when Automatic resolves to a customer display for this device', async () => {
    const session = structuredClone(managedSession);
    const device = session.devices[0];
    if (!device?.capabilities) throw new Error('Missing fixture device.');
    device.overrides = { follows: ['door-1'] };
    device.capabilities.surfaces = ['phone'];
    let saved: { overrides?: { follows?: string[] } } | undefined;
    await renderApp('/admin/scanning/sessions/session-1?deviceId=device-1', {
      session: 'admin',
      memberships: [membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' })],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/scan-setups': () => json({ items: [], nextCursor: null }),
        '/api/v1/templates/eligible': () => json({ items: [], nextCursor: null }),
        '/api/v1/scan-events': () => json({ items: [], nextCursor: null }),
        '/api/v1/scanning-sessions': () => json({ items: [session], nextCursor: null }),
        '/api/v1/scanning-sessions/session-1': () => json(session),
        '/api/v1/scanning-sessions/session-1/devices/device-1': (_url, init) => {
          saved = JSON.parse(String(init?.body));
          return json({ ...device, ...saved, updatedAt: session.updatedAt + 1 });
        },
      },
    });
    const dialog = await screen.findByRole('dialog', { name: 'Configure Admin phone' });
    await userEvent.click(within(dialog).getByRole('button', { name: /^Automatic/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save device' }));
    await waitFor(() => expect(saved?.overrides?.follows).toEqual(['door-1']));
  });
});
