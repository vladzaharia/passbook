import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { AppProviders } from '@/web/lib/providers.tsx';
import { createQueryClient } from '@/web/lib/query-client.ts';
import {
  json,
  membershipFixture,
  problem,
  sessionFixture,
  stubFetch,
} from '@/web/lib/test-utils.tsx';
import { eligibleTemplateFixture } from '../test-fixtures.ts';
import { NewSessionDialog } from './session-dialog.tsx';
import { managedSession } from './test-fixtures.ts';

afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
  localStorage.removeItem('wallet-org-filter');
});

const eventFixture = (n: number, status = 'upcoming') => ({
  id: `e${n}`,
  orgId: 'o1',
  mode: 'live',
  name: `Gala ${n}`,
  templateIds: [],
  match: null,
  opensAt: 1_800_000_000_000,
  closesAt: 1_800_003_600_000,
  timeZone: 'UTC',
  capacity: null,
  reentry: false,
  note: null,
  status,
  arrived: 0,
  expected: 0,
  scanners: 0,
});

function setup({
  types = 1,
  events = 1,
  initial,
  fail,
}: {
  types?: number;
  events?: number;
  initial?: ScanningSession;
  fail?: Response;
} = {}) {
  localStorage.removeItem('wallet-org-filter');
  const writes: Record<string, unknown>[] = [];
  const memberships = [membershipFixture('o1', { orgName: 'Northwind' })];
  stubFetch({
    '/api/v1/orgs/memberships/me': () => json({ items: memberships }),
    '/api/v1/templates/eligible': () =>
      json({
        items: Array.from({ length: types }, (_, i) =>
          eligibleTemplateFixture({ templateId: `t${i + 1}`, name: `Type ${i + 1}` }),
        ),
        nextCursor: null,
      }),
    '/api/v1/scan-events': () =>
      json({
        items: Array.from({ length: events }, (_, i) => eventFixture(i + 1)),
        nextCursor: null,
      }),
    '/api/v1/scanning-sessions': (_url: URL, init?: RequestInit) => {
      writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return fail ?? json({ ...managedSession, id: 'created' });
    },
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
  queryClient.setQueryData(['session'], sessionFixture('admin'));
  queryClient.setQueryData(['org-memberships', 'me'], { items: memberships });
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => root,
    path: '/admin/o/$orgId/$',
    component: () => <NewSessionDialog initial={initial} onClose={() => {}} onCreated={() => {}} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/admin/o/o1/scanning'] }),
  });
  render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { writes };
}

async function open() {
  const user = userEvent.setup();
  const dialog = await screen.findByRole('dialog', { name: 'New scanning session' });
  await user.type(await within(dialog).findByRole('textbox', { name: 'Session name' }), 'Entry');
  await user.click(within(dialog).getByRole('switch', { name: 'Any pass type' }));
  return { user, dialog };
}

describe('the Admits picker', () => {
  it('saves pass types and events together, and shows them as chips', async () => {
    const { writes } = setup({ types: 2, events: 2 });
    const { user, dialog } = await open();
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Type 1' }));
    await user.click(within(dialog).getByRole('checkbox', { name: /Gala 2/ }));
    expect(within(dialog).getByRole('button', { name: 'Remove Type 1' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Remove Gala 2' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ accepts: { templateIds: ['t1'], eventIds: ['e2'] } });
  });

  it('takes a chip off with one tap and searches both lists', async () => {
    setup({ types: 2, events: 2 });
    const { user, dialog } = await open();
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Type 2' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove Type 2' }));
    expect(within(dialog).getByRole('checkbox', { name: 'Type 2' })).not.toBeChecked();
    await user.type(
      within(dialog).getByRole('searchbox', { name: 'Search pass types and events' }),
      'gala',
    );
    expect(within(dialog).queryByRole('checkbox', { name: 'Type 1' })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('checkbox', { name: /Gala/ })).toHaveLength(2);
  });

  it('stops at 10 events', async () => {
    setup({ types: 0, events: 11 });
    const { user, dialog } = await open();
    for (let n = 1; n <= 10; n++)
      await user.click(
        await within(dialog).findByRole('checkbox', { name: new RegExp(`^Gala ${n}(?!\\d)`) }),
      );
    expect(within(dialog).getByText('10 of 10')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: /Gala 11/ })).toBeDisabled();
  });

  it('shows the server refusal and keeps the choice', async () => {
    const { writes } = setup({
      fail: problem(422, 'ADMITS_TOO_MANY', 'Admits more than 100 pass types in all.'),
    });
    const { user, dialog } = await open();
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Type 1' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    expect(await within(dialog).findByText(/more than 100 pass types/)).toBeInTheDocument();
    expect(writes).toHaveLength(1);
    expect(within(dialog).getByRole('checkbox', { name: 'Type 1' })).toBeChecked();
  });

  it('opens a mixed session with both chosen', async () => {
    const { writes } = setup({
      types: 1,
      events: 1,
      initial: { ...managedSession, accepts: { templateIds: ['t1'], eventIds: ['e1'] } },
    });
    const dialog = await screen.findByRole('dialog', { name: 'Duplicate session' });
    expect(await within(dialog).findByRole('checkbox', { name: 'Type 1' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /Gala 1/ })).toBeChecked();
    expect(writes).toEqual([]);
  });
});
