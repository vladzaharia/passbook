import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import {
  memoryStorage,
  northwind,
  openAction,
  otherHandlers,
  person,
} from './staff-test-fixtures.ts';

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
});

describe('Scanning staff', () => {
  it('uses the console mode header and reloads mode-specific activity and locks', async () => {
    setMode('test');
    const modes: (string | undefined)[] = [];
    const writeModes: (string | undefined)[] = [];
    await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': (_url, init) => {
          if (!init?.headers) throw new Error('Expected scan staff request headers.');
          const mode = (init.headers as Record<string, string>)['x-passbook-mode'];
          modes.push(mode);
          return json({
            items: [person({ today: mode === 'test' ? 3 : 8, locked: mode === 'test' })],
          });
        },
        '/api/v1/scan-staff/staff-1/reset-pin': (url, init) => {
          expect(url.searchParams.get('orgId')).toBe('o1');
          if (!init?.headers) throw new Error('Expected reset PIN request headers.');
          writeModes.push((init.headers as Record<string, string>)['x-passbook-mode']);
          return json({ pin: '888111' });
        },
      },
    });
    expect(await screen.findByText('Locked on a scanner')).toBeInTheDocument();
    expect(
      screen.getByText(
        "3 successful, not-undone scans since each scanner's local midnight for Sam K.; removed scanners use UTC",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Staff and PINs are shared/)).toHaveTextContent('Test mode');
    await openAction('Sam K.', 'Reset PIN');
    const user = userEvent.setup();
    const confirm = screen.getByRole('alertdialog', { name: "Reset Sam K.'s PIN?" });
    await user.click(within(confirm).getByRole('button', { name: 'Reset PIN' }));
    const reveal = await screen.findByRole('dialog', { name: "Sam K.'s PIN" });
    await user.click(within(reveal).getByRole('checkbox', { name: 'I saved the PIN' }));
    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    expect(writeModes).toEqual(['test']);
    await act(async () => setMode('live'));
    expect(
      await screen.findByText(
        "8 successful, not-undone scans since each scanner's local midnight for Sam K.; removed scanners use UTC",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Locked on a scanner')).not.toBeInTheDocument();
    expect(screen.getByText(/Staff and PINs are shared/)).toHaveTextContent('Live mode');
    expect(modes).toContain('test');
    expect(modes).toContain(undefined);
  });

  it('discards a one-time PIN when the selected organization changes', async () => {
    const { router, queryClient } = await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind, membershipFixture('o2', { orgName: 'Other', orgSlug: 'other' })],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': (url, init) => {
          if (init?.method === 'POST') return json({ staff: person(), pin: '555888' }, 201);
          return json({
            items:
              url.searchParams.get('orgId') === 'o1'
                ? []
                : [person({ id: 'staff-2', orgId: 'o2', name: 'Other' })],
          });
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add staff' }));
    const form = screen.getByRole('dialog', { name: 'Add staff' });
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Sam K.');
    await user.click(within(form).getByRole('button', { name: 'Add staff' }));
    const reveal = await screen.findByRole('dialog', { name: "Sam K.'s PIN" });
    await user.click(within(reveal).getByRole('button', { name: 'Show PIN' }));
    expect(within(reveal).getByText('555888')).toBeInTheDocument();
    await act(async () => {
      await router.navigate({ to: '/admin/scanning', search: { tab: 'staff', orgId: 'o2' } });
    });
    // The top bar also names the selected organization: look in the staff table.
    expect(
      await within(await screen.findByRole('table', { name: 'Staff' })).findByText('Other'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: "Sam K.'s PIN" })).not.toBeInTheDocument();
    expect(screen.queryByText('555888')).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('555888');
  });
});
