import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { NOW, scannerFixture, templateFixture } from './test-fixtures.ts';

const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const harbor = membershipFixture('o2', { orgName: 'Harbor', orgSlug: 'harbor' });
const page = (items: unknown[]) => json({ items, nextCursor: null });
const event = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  orgId: 'o1',
  mode: 'live',
  name: 'Summer admission',
  templateIds: ['t1'],
  match: null,
  opensAt: NOW,
  closesAt: NOW + 3_600_000,
  timeZone: 'UTC',
  capacity: null,
  reentry: false,
  note: 'Private instructions',
  status: 'upcoming',
  arrived: 2,
  expected: 10,
  scanners: 0,
  ...over,
});

afterEach(() => resetModeForTests());

describe('Event detail organization scope', () => {
  it('canonicalizes an unscoped event link to its authorized organization rather than the remembered one', async () => {
    const previous = localStorage.getItem('wallet-org-filter');
    localStorage.setItem('wallet-org-filter', 'o1');
    try {
      const seen: (string | null)[] = [];
      const { router } = await renderApp('/admin/scanning/events/e1', {
        session: 'admin',
        memberships: [northwind, harbor],
        handlers: {
          '/api/v1/scan-events/e1': () => json(event({ orgId: 'o2', name: 'Harbor admission' })),
          '/api/v1/scanners': (url) => {
            seen.push(url.searchParams.get('orgId'));
            return page([]);
          },
          '/api/v1/templates': (url) => {
            seen.push(url.searchParams.get('orgId'));
            return page([]);
          },
        },
      });
      expect(
        await screen.findByRole('heading', { name: 'Harbor admission', level: 1 }),
      ).toBeInTheDocument();
      await waitFor(() => expect(router.state.location.search.orgId).toBe('o2'));
      await waitFor(() => expect(seen).toContain('o2'));
      expect(seen.every((id) => id === 'o2')).toBe(true);
    } finally {
      if (previous === null) localStorage.removeItem('wallet-org-filter');
      else localStorage.setItem('wallet-org-filter', previous);
    }
  });

  it('does not adopt an event organization without membership, even for a platform admin', async () => {
    const previous = localStorage.getItem('wallet-org-filter');
    localStorage.setItem('wallet-org-filter', 'o1');
    try {
      const unexpected: string[] = [];
      const { router } = await renderApp('/admin/scanning/events/e1', {
        session: 'admin',
        memberships: [northwind],
        handlers: {
          '/api/v1/scan-events/e1': () => json(event({ orgId: 'o2', name: 'Private event' })),
          '/api/v1/scanners': () => {
            unexpected.push('scanners');
            return page([]);
          },
          '/api/v1/templates': () => {
            unexpected.push('templates');
            return page([]);
          },
        },
      });
      expect(await screen.findByText('Event not found')).toBeInTheDocument();
      expect(screen.queryByText('Private event')).not.toBeInTheDocument();
      expect(router.state.location.search.orgId).toBeUndefined();
      expect(unexpected).toEqual([]);
    } finally {
      if (previous === null) localStorage.removeItem('wallet-org-filter');
      else localStorage.setItem('wallet-org-filter', previous);
    }
  });

  it('keeps event details readable without offering scanning management actions', async () => {
    await renderApp('/admin/scanning/events/e1', {
      session: 'admin',
      memberships: [
        membershipFixture('o1', { capabilities: ['org:read', 'scanning:read', 'templates:read'] }),
      ],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/scan-events/e1': () => json(event()),
        '/api/v1/scanners': () => page([]),
        '/api/v1/templates': () => page([templateFixture()]),
      },
    });
    expect(await screen.findByText('Private instructions')).toBeInTheDocument();
    expect(await screen.findByText(/Result screen: Gala ticket/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit event' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign scanners' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive event' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open scanner' })).not.toBeInTheDocument();
  });

  it.each([
    {
      label: 'scanning manager without template author access',
      capabilities: ['org:read', 'scanning:read', 'scanning:manage', 'templates:read'] as const,
      canAuthor: false,
    },
    {
      label: 'template author without scanning management',
      capabilities: ['org:read', 'scanning:read', 'templates:read', 'templates:author'] as const,
      canAuthor: true,
    },
  ])(
    'uses template author capability for result-screen editing: $label',
    async ({ capabilities, canAuthor }) => {
      await renderApp('/admin/scanning/events/e1', {
        session: 'user',
        memberships: [membershipFixture('o1', { capabilities: [...capabilities] })],
        selectedOrg: 'o1',
        handlers: {
          '/api/v1/scan-events/e1': () => json(event()),
          '/api/v1/scanners': () => page([]),
          '/api/v1/templates': () => page([templateFixture()]),
        },
      });
      expect(await screen.findByText(/Result screen: Gala ticket/)).toBeInTheDocument();
      const edit = screen.queryByRole('link', { name: 'Edit' });
      if (canAuthor) expect(edit).toBeInTheDocument();
      else expect(edit).not.toBeInTheDocument();
    },
  );

  it('hides another selected organization’s event without starting dependent queries', async () => {
    const unexpected: string[] = [];
    let loaded = 0;
    await renderApp('/admin/scanning/events/e1', {
      session: 'admin',
      memberships: [northwind, harbor],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/scan-events/e1': () => {
          loaded += 1;
          return json(event({ orgId: 'o2', name: 'Harbor admission' }));
        },
        '/api/v1/scanners': () => {
          unexpected.push('scanners');
          return page([]);
        },
        '/api/v1/templates': () => {
          unexpected.push('templates');
          return page([]);
        },
      },
    });
    expect(await screen.findByText('Event not found')).toBeInTheDocument();
    expect(loaded).toBeGreaterThan(0);
    expect(screen.queryByText('Harbor admission')).not.toBeInTheDocument();
    expect(screen.queryByText('Private instructions')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit event' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign scanners' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open scanner' })).not.toBeInTheDocument();
    expect(unexpected).toEqual([]);
  });

  it('unmounts open actions and cached details on an organization switch', async () => {
    const archived: string[] = [];
    const { router, queryClient } = await renderApp('/admin/scanning/events/e1', {
      session: 'admin',
      memberships: [northwind, harbor],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/scan-events/e1': () => json(event()),
        '/api/v1/scanners': () => page([]),
        '/api/v1/templates': () => page([]),
        '/api/v1/scan-events/e1/archive': (url) => {
          archived.push(url.pathname);
          return json(event({ status: 'archived' }));
        },
      },
    });
    const user = userEvent.setup();
    expect(
      await screen.findByRole('heading', { name: 'Summer admission', level: 1 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archive event' }));
    expect(await screen.findByRole('alertdialog', { name: 'Archive event?' })).toBeInTheDocument();

    await act(async () => {
      await router.navigate({
        to: '/admin/scanning/events/$eventId',
        params: { eventId: 'e1' },
        search: { orgId: 'o2' },
      });
    });
    expect(await screen.findByText('Event not found')).toBeInTheDocument();
    expect(queryClient.getQueryData(['admin', 'scanning', 'events', 'e1'])).toMatchObject({
      orgId: 'o1',
    });
    expect(screen.queryByText('Summer admission')).not.toBeInTheDocument();
    expect(screen.queryByText('Private instructions')).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive event' })).not.toBeInTheDocument();
    expect(archived).toEqual([]);

    await act(async () => {
      await router.navigate({
        to: '/admin/scanning/events/$eventId',
        params: { eventId: 'e1' },
        search: { orgId: 'o1' },
      });
    });
    expect(
      await screen.findByRole('heading', { name: 'Summer admission', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('closes an event editor when the console mode changes', async () => {
    await renderApp('/admin/scanning/events/e1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/scan-events/e1': () => json(event()),
        '/api/v1/scanners': () => page([]),
        '/api/v1/templates': () => page([]),
        '/api/v1/templates/eligible': () => page([]),
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit event' }));
    expect(await screen.findByRole('dialog', { name: 'Edit event' })).toBeInTheDocument();
    act(() => setMode('test'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit event' })).not.toBeInTheDocument(),
    );
    act(() => setMode('live'));
    expect(
      await screen.findByRole('heading', { name: 'Summer admission', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Edit event' })).not.toBeInTheDocument();
  });

  it('shows only the selected organization’s related scanners and its or shared templates', async () => {
    const assignments: unknown[] = [];
    await renderApp('/admin/scanning/events/e1', {
      session: 'admin',
      memberships: [northwind, harbor],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/scan-events/e1': () => json(event({ templateIds: ['t1', 'shared', 'foreign'] })),
        '/api/v1/scanners': () =>
          page([
            scannerFixture({ name: 'Own scanner', accepts: { eventId: 'e1' } }),
            scannerFixture({
              id: 's2',
              orgId: 'o2',
              name: 'Foreign scanner',
              accepts: { eventId: 'e1' },
            }),
          ]),
        '/api/v1/templates': () =>
          page([
            templateFixture({ name: 'Own template' }),
            templateFixture({ id: 'shared', orgId: null, orgName: null, name: 'Shared template' }),
            templateFixture({ id: 'foreign', orgId: 'o2', name: 'Foreign template' }),
          ]),
        '/api/v1/scan-events/e1/scanners': (_url, init) => {
          assignments.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 204 });
        },
      },
    });
    expect(await screen.findByText('Own scanner')).toBeInTheDocument();
    expect(await screen.findByText(/Result screen: Shared template/)).toBeInTheDocument();
    expect(screen.getByText(/Result screen: Own template/)).toBeInTheDocument();
    expect(screen.queryByText('Foreign scanner')).not.toBeInTheDocument();
    expect(screen.queryByText(/Foreign template/)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Assign scanners' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign scanners' });
    expect(await within(dialog).findByRole('checkbox', { name: 'Own scanner' })).toBeChecked();
    expect(within(dialog).queryByText('Foreign scanner')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Assign scanners' }));
    await waitFor(() => expect(assignments).toEqual([{ scannerIds: ['s1'] }]));
  });
});
