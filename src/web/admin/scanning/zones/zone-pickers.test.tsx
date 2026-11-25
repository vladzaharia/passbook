import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { reach, reachStep } from '../sessions/wizard-test-nav.ts';
import { scannerFixture } from '../test-fixtures.ts';
import type { InsideApi } from './inside-api.ts';
import { InsideSheet } from './inside-sheet.tsx';
import { ACTIVE_ZONES, gym } from './test-fixtures.ts';

afterEach(() => resetModeForTests());
const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const page = (items: unknown[]) => json({ items, nextCursor: null });
const base = {
  '/api/v1/scan-zones': () => page(ACTIVE_ZONES),
  '/api/v1/scan-setups': () => page([]),
  '/api/v1/scan-events': () => page([]),
  '/api/v1/templates/eligible': () => page([]),
};

describe('session pickers', () => {
  async function openNew(extra: Record<string, (url: URL, init?: RequestInit) => Response> = {}) {
    const writes: Record<string, unknown>[] = [];
    await renderApp('/admin/scanning?new=1&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...base,
        '/api/v1/scanning-sessions': (_url, init) => {
          if (init?.method !== 'POST') return page([]);
          writes.push(JSON.parse(String(init.body)));
          return json({ id: 'made' }, 500);
        },
        ...extra,
      },
    });
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    return { dialog, writes, user: userEvent.setup() };
  }

  it('sends zones, direction, Desk actions and customer lines from the Access tabs', async () => {
    const { dialog, writes, user } = await openNew();
    await user.type(
      await within(dialog).findByRole('textbox', { name: 'Session name' }),
      'Pool door',
    );
    await reachStep(user, dialog, 'Set where it scans');
    await user.click(await within(dialog).findByRole('button', { name: 'Choose zones' }));
    const tree = await screen.findByRole('list', { name: 'Zones' });
    expect(
      within(tree)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-level')),
    ).toEqual(['1', '2', '3', '1']);
    await user.click(within(tree).getByRole('checkbox', { name: 'Pool' }));
    await user.click(within(tree).getByRole('checkbox', { name: 'Sauna' }));
    await user.keyboard('{Escape}');
    expect(within(dialog).getByRole('button', { name: 'Remove Pool' })).toBeInTheDocument();
    expect(within(dialog).getByText(/2 of 8\./)).toBeInTheDocument();
    expect(within(dialog).getByText(/Counts people in Pool · 25 inside now\./)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: /^Out/ }));
    await user.click(within(dialog).getByRole('switch', { name: 'Desk actions' }));
    expect(within(dialog).getByText(/signed by the staff member/)).toBeInTheDocument();
    await reachStep(user, dialog, 'Set the customer screen');
    await user.type(within(dialog).getByRole('textbox', { name: 'Welcome' }), 'Tap to enter');
    await user.click(within(dialog).getByRole('switch', { name: 'Greet by first name' }));
    await user.click(await reach(user, dialog, 'Create session'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      name: 'Pool door',
      zoneIds: ['z-pool', 'z-sauna'],
      settings: {
        direction: 'out',
        deskActions: true,
        customer: { welcome: 'Tap to enter', greet: false },
      },
    });
  });

  it('opens the zone dialog from an empty picker and keeps the session draft', async () => {
    const { dialog, user } = await openNew({ '/api/v1/scan-zones': () => page([]) });
    await user.type(
      await within(dialog).findByRole('textbox', { name: 'Session name' }),
      'Pool door',
    );
    await reachStep(user, dialog, 'Set where it scans');
    await user.click(await within(dialog).findByRole('button', { name: 'Choose zones' }));
    expect(await screen.findByText('No zones yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New zone' }));
    expect(await screen.findByRole('dialog', { name: 'New zone' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(within(dialog).getByRole('button', { name: 'Passes' }));
    expect(within(dialog).getByRole('textbox', { name: 'Session name' })).toHaveValue('Pool door');
  });

  it('removes a chip, stops at 8 and disables Zones on an event session', async () => {
    const gala = {
      id: 'e1',
      orgId: 'o1',
      mode: 'live',
      name: 'Gala',
      templateIds: [],
      match: null,
      opensAt: 1_800_000_000_000,
      closesAt: 1_800_003_600_000,
      timeZone: 'UTC',
      capacity: null,
      reentry: false,
      note: null,
      status: 'upcoming',
      arrived: 0,
      expected: 0,
      scanners: 0,
    };
    const { dialog, writes, user } = await openNew({ '/api/v1/scan-events': () => page([gala]) });
    await user.type(await within(dialog).findByRole('textbox', { name: 'Session name' }), 'Gate');
    await reachStep(user, dialog, 'Set where it scans');
    await user.click(await within(dialog).findByRole('button', { name: 'Choose zones' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Gym' }));
    await user.keyboard('{Escape}');
    await user.click(within(dialog).getByRole('button', { name: 'Remove Gym' }));
    expect(within(dialog).getByText('Any zone')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Passes' }));
    await user.click(within(dialog).getByRole('switch', { name: 'Any pass type' }));
    await user.click(await within(dialog).findByRole('checkbox', { name: /Gala/ }));
    await reachStep(user, dialog, 'Set where it scans');
    expect(within(dialog).getByRole('button', { name: 'Choose zones' })).toBeDisabled();
    expect(
      within(dialog).getByText('Events check in once. Zones don’t apply.'),
    ).toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('leaves Zones out when the server has no zones route', async () => {
    const { dialog, user } = await openNew({
      '/api/v1/scan-zones': () =>
        json(
          { type: 'about:blank', title: 'nf', status: 404, code: 'not_found', detail: 'x' },
          404,
        ),
    });
    await user.type(await within(dialog).findByRole('textbox', { name: 'Session name' }), 'Gate');
    await reachStep(user, dialog, 'Set where it scans');
    await waitFor(() =>
      expect(
        within(dialog).queryByRole('button', { name: 'Choose zones' }),
      ).not.toBeInTheDocument(),
    );
    expect(within(dialog).getByRole('switch', { name: 'Desk actions' })).toBeInTheDocument();
  });
});

describe('monitor watch', () => {
  it('watches by zone: sends zoneIds and Desk actions', async () => {
    const saved: Record<string, unknown>[] = [];
    const monitor = scannerFixture({
      deviceRole: 'monitor',
      kind: 'display',
      watch: { scannerIds: [], allOrg: true },
      name: 'Desk monitor',
    });
    await renderApp('/admin/scanning/scanners/s1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        ...base,
        '/api/v1/scanning-sessions': () => page([]),
        '/api/v1/scan-setups/s1': (_url, init) => {
          if (init?.method === 'PATCH') {
            saved.push(JSON.parse(String(init.body)));
            return json(monitor);
          }
          return json(monitor);
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Zones' }));
    await user.click(await screen.findByRole('button', { name: 'Choose zones' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Pool' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('switch', { name: 'Desk actions' }));
    await user.click(await screen.findByRole('button', { name: /Save/ }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({
      watch: { scannerIds: [], allOrg: false, zoneIds: ['z-pool'] },
      settings: { deskActions: true },
    });
  });
});

describe('inside list', () => {
  function sheet(api: InsideApi) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <InsideSheet api={api} zoneId={gym.id} zoneName="Gym" canManage onClose={() => {}} />
      </QueryClientProvider>,
    );
  }
  it('lists who is inside and marks someone out after a confirm', async () => {
    const markOut = vi.fn(async () => {});
    sheet({
      list: async () => ({
        total: 1,
        nextCursor: null,
        items: [
          {
            passId: 'p1',
            holder: 'Maya R.',
            photoUrl: null,
            plan: null,
            place: 'zone:z-gym',
            since: 1_700_000_000_000,
            via: null,
            flags: ['long_stay'],
          },
        ],
      }),
      markOut,
    });
    const user = userEvent.setup();
    expect(await screen.findByRole('rowheader', { name: /Maya R\./ })).toHaveTextContent(
      'Long stay',
    );
    await user.click(screen.getByRole('button', { name: 'Mark as out' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Mark Maya R. as out?' });
    await user.click(within(dialog).getByRole('button', { name: 'Mark as out' }));
    await waitFor(() => expect(markOut).toHaveBeenCalledWith('p1', 'zone:z-gym'));
  });
});
