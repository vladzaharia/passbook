import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { ScanningSessionDetailSchema } from '@/shared/contracts/scanning-sessions.ts';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
import { NOW, scannerFixture } from '../test-fixtures.ts';

const session = ScanningSessionDetailSchema.parse({
  id: 'session-1',
  orgId: 'o1',
  orgName: 'Northwind',
  mode: 'live',
  name: 'Membership desk',
  status: 'active',
  accepts: null,
  settings: { ...scannerFixture().settings, lookup: true, checkIn: { mode: 'in_out' } },
  timeZone: 'UTC',
  createdAt: NOW,
  updatedAt: NOW,
  deviceCount: 1,
  onlineCount: 1,
  today: 4,
  devices: [
    {
      id: 'device-1',
      sessionId: 'session-1',
      name: 'Admin phone',
      surface: 'operator',
      effectiveSurface: 'operator',
      overrides: {},
      settings: scannerFixture().settings,
      capabilities: {
        width: 390,
        height: 844,
        touch: true,
        camera: 'available',
        keyboard: true,
        nativeBarcode: false,
        surfaces: ['phone', 'operator', 'desk', 'customer'],
        preferred: 'phone',
      },
      reportedAt: NOW,
      paired: true,
      online: true,
      revoked: false,
      lastSeenAt: NOW,
      updatedAt: NOW,
      signIn: 'admin',
      adminName: 'Administrator',
    },
  ],
});
const handlers = {
  '/api/v1/scanning-sessions/session-1': () => json(session),
  '/api/v1/scanning-sessions': () => json({ items: [session], nextCursor: null }),
  '/api/v1/scan-setups': () => json({ items: [], nextCursor: null }),
};

describe('session administration', () => {
  it('shows shared rules, devices and activity with an accessible layout', async () => {
    const { container } = await renderApp('/admin/scanning/sessions/session-1', {
      session: 'admin',
      handlers,
    });
    expect(
      await screen.findByRole('heading', { name: 'Membership desk', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Session rules' })).toBeInTheDocument();
    expect(screen.getByTestId('session-device')).toHaveTextContent('Admin phone');
    expect(screen.getByTestId('session-device')).toHaveTextContent('390 × 844');
    expect(screen.getByText('In / out')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });
  it('allows the operator layout on a phone and protects unsaved device settings', async () => {
    await renderApp('/admin/scanning/sessions/session-1?deviceId=device-1', {
      session: 'admin',
      handlers,
    });
    const dialog = await screen.findByRole('dialog', { name: 'Configure Admin phone' });
    expect(within(dialog).getByRole('button', { name: /Operator/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /^Scanner/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /Customer display/ })).toBeEnabled();
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
});
