import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import type { ScanStaff } from './staff-dialogs.tsx';
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
  it('keeps an open action menu usable while staff activity refreshes', async () => {
    let current = person();
    const { queryClient } = await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': () => json({ items: [current] }),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Sam K.' }));
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();

    current = person({ today: 7 });
    await queryClient.invalidateQueries({ queryKey: ['admin', 'scanning', 'staff', 'o1'] });
    await screen.findByText(/7 successful, not-undone scans/);
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Edit Sam K.' })).toBeInTheDocument();
  });

  it('confirms a role change, sends the scoped update, and refreshes the list', async () => {
    let current = person();
    let saved: unknown;
    let updateUrl: URL | undefined;
    let gets = 0;
    await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': () => {
          gets += 1;
          return json({ items: [current] });
        },
        '/api/v1/scan-staff/staff-1': (url, init) => {
          updateUrl = url;
          saved = JSON.parse(String(init?.body));
          current = { ...current, ...(saved as Partial<ScanStaff>) };
          return json(current);
        },
      },
    });
    const user = userEvent.setup();
    await openAction('Sam K.', 'Edit');
    const form = screen.getByRole('dialog', { name: 'Edit Sam K.' });
    const name = within(form).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Sam Updated');
    await user.click(within(form).getByRole('radio', { name: /Manager/ }));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    const confirm = await screen.findByRole('alertdialog', { name: "Change Sam K.'s role?" });
    expect(confirm).toHaveTextContent('both live and test');
    expect(saved).toBeUndefined();
    await user.click(within(confirm).getByRole('button', { name: 'Change role' }));
    expect(await screen.findByText('Sam Updated')).toBeInTheDocument();
    expect(saved).toEqual({ name: 'Sam Updated', role: 'manager' });
    expect(updateUrl?.searchParams.get('orgId')).toBe('o1');
    await waitFor(() => expect(gets).toBeGreaterThan(1));
  });

  it('confirms disabling and enabling, preserves scans, and refreshes the access status', async () => {
    let current = person();
    const changes: unknown[] = [];
    await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': () => json({ items: [current] }),
        '/api/v1/scan-staff/staff-1': (url, init) => {
          expect(url.searchParams.get('orgId')).toBe('o1');
          const update = JSON.parse(String(init?.body)) as { disabled: boolean };
          changes.push(update);
          current = { ...current, disabledAt: update.disabled ? Date.now() : null };
          return json(current);
        },
      },
    });
    const user = userEvent.setup();
    await openAction('Sam K.', 'Disable');
    let confirm = screen.getByRole('alertdialog', { name: 'Disable Sam K.?' });
    expect(confirm).toHaveTextContent('Their scans remain');
    expect(confirm).toHaveTextContent('signed out of all scanners');
    expect(confirm).toHaveTextContent('both live and test');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(changes).toHaveLength(0);
    await openAction('Sam K.', 'Disable');
    confirm = screen.getByRole('alertdialog', { name: 'Disable Sam K.?' });
    await user.click(within(confirm).getByRole('button', { name: 'Disable' }));
    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    await openAction('Sam K.', 'Reset PIN');
    const reset = screen.getByRole('alertdialog', { name: "Reset Sam K.'s PIN?" });
    expect(reset).toHaveTextContent('They will remain disabled until you enable them.');
    await user.click(within(reset).getByRole('button', { name: 'Cancel' }));
    await openAction('Sam K.', 'Enable');
    confirm = screen.getByRole('alertdialog', { name: 'Enable Sam K.?' });
    expect(confirm).toHaveTextContent('existing PIN');
    await user.click(within(confirm).getByRole('button', { name: 'Enable' }));
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(changes).toEqual([{ disabled: true }, { disabled: false }]);
  });

  it('confirms a PIN reset and does not recover the old or new PIN from a cache', async () => {
    let resets = 0;
    let gets = 0;
    const { queryClient } = await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': () => {
          gets += 1;
          return json({ items: [person()] });
        },
        '/api/v1/scan-staff/staff-1/reset-pin': (url, init) => {
          expect(url.searchParams.get('orgId')).toBe('o1');
          expect(init?.method).toBe('POST');
          resets += 1;
          return json({ pin: resets === 1 ? '123456' : '654321' });
        },
      },
    });
    const user = userEvent.setup();
    await openAction('Sam K.', 'Reset PIN');
    let confirm = screen.getByRole('alertdialog', { name: "Reset Sam K.'s PIN?" });
    expect(confirm).toHaveTextContent('old PIN stops working');
    expect(confirm).toHaveTextContent('signed out of all scanners');
    expect(confirm).toHaveTextContent('Temporary PIN locks remain until they expire');
    expect(confirm).toHaveTextContent('both live and test');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(resets).toBe(0);
    await openAction('Sam K.', 'Reset PIN');
    confirm = screen.getByRole('alertdialog', { name: "Reset Sam K.'s PIN?" });
    await user.click(within(confirm).getByRole('button', { name: 'Reset PIN' }));
    let reveal = await screen.findByRole('dialog', { name: "Sam K.'s PIN" });
    await user.click(within(reveal).getByRole('button', { name: 'Show PIN' }));
    expect(within(reveal).getByText('123456')).toBeInTheDocument();
    await user.click(within(reveal).getByRole('checkbox', { name: 'I saved the PIN' }));
    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: "Sam K.'s PIN" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('123456')).not.toBeInTheDocument();
    await waitFor(() => expect(gets).toBeGreaterThan(1));
    await openAction('Sam K.', 'Reset PIN');
    confirm = screen.getByRole('alertdialog', { name: "Reset Sam K.'s PIN?" });
    await user.click(within(confirm).getByRole('button', { name: 'Reset PIN' }));
    reveal = await screen.findByRole('dialog', { name: "Sam K.'s PIN" });
    await user.click(within(reveal).getByRole('button', { name: 'Show PIN' }));
    expect(within(reveal).getByText('654321')).toBeInTheDocument();
    expect(within(reveal).queryByText('123456')).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toMatch(/123456|654321/);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('reports a reset failure without claiming a new PIN or closing the confirmation', async () => {
    await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': () => json({ items: [person()] }),
        '/api/v1/scan-staff/staff-1/reset-pin': () =>
          problem(409, 'conflict', 'PIN reset unavailable.'),
      },
    });
    await openAction('Sam K.', 'Reset PIN');
    const confirm = screen.getByRole('alertdialog', { name: "Reset Sam K.'s PIN?" });
    await userEvent.setup().click(within(confirm).getByRole('button', { name: 'Reset PIN' }));
    expect(await within(confirm).findByText('PIN reset unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: "Sam K.'s PIN" })).not.toBeInTheDocument();
  });
});
