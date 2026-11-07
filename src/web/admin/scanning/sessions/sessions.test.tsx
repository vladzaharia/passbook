import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, renderApp } from '@/web/lib/test-utils.tsx';

import { managedSession as session } from './test-fixtures.ts';

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
    expect(within(dialog).getByText('iPhone/iPad')).toBeInTheDocument();
    expect(within(dialog).getByText('NDEF tag input')).toBeInTheDocument();
    expect(within(dialog).getByText('Wallet pass reader unavailable')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^Operator/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /^Scanner/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /Customer display/ })).toBeEnabled();
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
      handlers,
    });
    const dialog = await screen.findByRole('dialog', { name: 'Add device' });
    expect(within(dialog).getByRole('button', { name: /^Scanner/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /^Operator/ })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /^Customer display/ })).toBeEnabled();
    expect(within(dialog).queryByRole('button', { name: /Desk display/ })).not.toBeInTheDocument();
  });
});
