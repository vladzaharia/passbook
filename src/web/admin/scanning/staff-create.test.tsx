import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, renderApp } from '@/web/lib/test-utils.tsx';
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
  it('validates the staff name before sending a create request', async () => {
    let creates = 0;
    await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': (_url, init) => {
          if (init?.method === 'POST') creates += 1;
          return json({ items: [] });
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add staff' }));
    const form = screen.getByRole('dialog', { name: 'Add staff' });
    const button = within(form).getByRole('button', { name: 'Add staff' });
    expect(button).toBeDisabled();
    fireEvent.change(within(form).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Sam\u202eK' },
    });
    await user.click(button);
    expect(
      within(form).getByText('Enter a name of up to 40 plain-text characters.'),
    ).toBeInTheDocument();
    expect(creates).toBe(0);
  });

  it('does not retry an ambiguous create or expose a malformed PIN', async () => {
    let created = false;
    let creates = 0;
    await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': (_url, init) => {
          if (init?.method === 'POST') {
            creates += 1;
            created = true;
            return json({ staff: person(), pin: '123' }, 201);
          }
          return json({ items: created ? [person()] : [] });
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add staff' }));
    const form = screen.getByRole('dialog', { name: 'Add staff' });
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Sam K.');
    await user.click(within(form).getByRole('button', { name: 'Add staff' }));
    expect(
      await within(form).findByText(/Could not confirm whether staff was added/),
    ).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Add staff' })).toBeDisabled();
    expect(screen.queryByRole('dialog', { name: "Sam K.'s PIN" })).not.toBeInTheDocument();
    // The dialog's corner X and the footer button are both named Close; use the footer one.
    await user.click(within(form).getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(await screen.findByText('Sam K.')).toBeInTheDocument();
    expect(creates).toBe(1);
  });

  it('creates validated staff, reveals the PIN once, and keeps it out of query and mutation caches', async () => {
    const people: ScanStaff[] = [];
    let body: unknown;
    let gets = 0;
    const { queryClient, container } = await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...otherHandlers,
        '/api/v1/scan-staff': (_url, init) => {
          if (init?.method !== 'POST') {
            gets += 1;
            return json({ items: people });
          }
          body = JSON.parse(String(init.body));
          const created = person({ name: 'Avery', role: 'desk' });
          people.push(created);
          return json({ staff: created, pin: '048219' }, 201);
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add staff' }));
    const form = screen.getByRole('dialog', { name: 'Add staff' });
    expect((await axe(form)).violations).toEqual([]);
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), '  Avery  ');
    await user.click(within(form).getByRole('radio', { name: /Desk/ }));
    await user.click(within(form).getByRole('button', { name: 'Add staff' }));
    const reveal = await screen.findByRole('dialog', { name: "Avery's PIN" });
    expect(body).toEqual({ orgId: 'o1', name: 'Avery', role: 'desk' });
    expect(within(reveal).getByText(/not shown again/)).toBeInTheDocument();
    expect(within(reveal).queryByText('048219')).not.toBeInTheDocument();
    expect(within(reveal).getByRole('button', { name: 'Done' })).toBeDisabled();
    await user.click(within(reveal).getByRole('button', { name: 'Show PIN' }));
    expect(within(reveal).getByText('048219')).toBeInTheDocument();
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('048219');
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    await user.click(within(reveal).getByRole('checkbox', { name: 'I saved the PIN' }));
    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: "Avery's PIN" })).not.toBeInTheDocument(),
    );
    expect(container).not.toHaveTextContent('048219');
    expect(await screen.findByText('Avery')).toBeInTheDocument();
    await waitFor(() => expect(gets).toBeGreaterThan(1));
    await openAction('Avery', 'Edit');
    expect(screen.getByRole('dialog', { name: 'Edit Avery' })).not.toHaveTextContent('048219');
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('048219');
  });
});
