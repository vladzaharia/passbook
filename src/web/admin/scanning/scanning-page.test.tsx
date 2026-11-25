import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { ENTITY } from '@/web/lib/entities.ts';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { ORG_NAV, PLATFORM_NAV } from '@/web/lib/nav.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { ScanLink } from './scan-link.tsx';
import { managedSession } from './sessions/test-fixtures.ts';
import { NOW, scannerFixture } from './test-fixtures.ts';

afterEach(() => resetModeForTests());

const empty = () => json({ items: [], nextCursor: null });
const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const readOnly = membershipFixture('o1', {
  orgName: 'Northwind',
  orgSlug: 'northwind',
  capabilities: ['org:read', 'scanning:read'],
});
const scanRecord = {
  id: 'scan-1',
  at: NOW,
  outcome: 'ok',
  reason: null,
  kind: 'check_in',
  actionId: null,
  actionLabel: 'Check in',
  direction: null,
  passId: 'pass-1',
  passTitle: 'Anna',
  templateId: 't1',
  templateName: 'Ticket',
  eventId: null,
  eventName: null,
  scannerId: 's1',
  scannerName: 'Front door',
  staffId: null,
  staffName: null,
  approvedBy: null,
  method: 'manual',
  amount: null,
  before: null,
  after: null,
  passVersion: 1,
  override: false,
  offline: false,
  actor: { type: 'scanner', id: 's1' },
  undoneAt: null,
  undoneBy: null,
  undoes: null,
};
const handlers = {
  '/api/v1/scanning-sessions': empty,
  '/api/v1/scan-setups': empty,
  '/api/v1/scan-events': empty,
  '/api/v1/scan-staff': empty,
  '/api/v1/scans': empty,
};

describe('Scanning nav and entities', () => {
  it('puts Scanning in the Messages group, inside the organization', () => {
    const item = ORG_NAV.flat().find((i) => i.section === '/scanning');
    expect(item).toMatchObject({ label: 'Scanning', entity: 'scanner' });
    const group = ORG_NAV.find((g) => g.some((i) => i.section === '/scanning'));
    expect(group?.map((i) => i.label)).toEqual(['Messages', 'Scanning', 'Test inbox']);
    expect(PLATFORM_NAV.flat().some((i) => i.section === '/scanning')).toBe(false);
  });

  it('names the scanning entities and gives "Event" to the occasion', () => {
    expect(ENTITY.scanner.label).toBe('Scanner');
    expect(ENTITY.event.label).toBe('Event');
    expect(ENTITY.staff.plural).toBe('staff');
    expect(ENTITY.activity).toMatchObject({ label: 'Entry', plural: 'entries' });
  });
});

describe('Scanning page', () => {
  it('requests scan history only for the organization in the URL', async () => {
    const previous = localStorage.getItem('wallet-org-filter');
    localStorage.removeItem('wallet-org-filter');
    try {
      const seen: (string | null)[] = [];
      const { fetchMock } = await renderApp('/admin/scanning?tab=activity', {
        session: 'admin',
        memberships: [readOnly],
        handlers: {
          ...handlers,
          '/api/v1/scans': (url) => {
            seen.push(url.searchParams.get('orgId'));
            return empty();
          },
        },
      });
      // The only organization opens; history is read in it and nowhere else.
      expect(await screen.findByText('No scans yet')).toBeInTheDocument();
      expect(
        fetchMock.mock.calls.every(
          ([url]) => !String(url).startsWith('/api/v1/scans?') || String(url).includes('orgId=o1'),
        ),
      ).toBe(true);
      expect(seen).toContain('o1');
      expect(seen.every((id) => id === 'o1')).toBe(true);
    } finally {
      if (previous === null) localStorage.removeItem('wallet-org-filter');
      else localStorage.setItem('wallet-org-filter', previous);
    }
  });

  it('keeps session lists readable but suppresses creation and scan actions for a read-only member', async () => {
    await renderApp('/admin/scanning?new=1', {
      session: 'admin',
      memberships: [readOnly],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/scanning-sessions': () => json({ items: [managedSession], nextCursor: null }),
      },
    });
    expect(await screen.findByRole('link', { name: 'Membership desk' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New session' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Scan as Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'New session' })).not.toBeInTheDocument();
  });

  it('keeps scanner and event lists readable without management controls', async () => {
    const { router } = await renderApp('/admin/scanning?tab=devices', {
      session: 'admin',
      memberships: [readOnly],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/scan-setups': () =>
          json({ items: [scannerFixture({ status: 'not_paired' })], nextCursor: null }),
      },
    });
    const table = await screen.findByRole('table', { name: 'Scanners' });
    expect(within(table).getByText('Front door')).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: 'Pair' })).not.toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New session' })).not.toBeInTheDocument();
    await act(async () => {
      await router.navigate({ to: '/admin/scanning', search: { orgId: 'o1', tab: 'events' } });
    });
    expect(await screen.findByText('No events yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New event' })).not.toBeInTheDocument();
  });

  it.each([
    ['scanners', 'devices'],
    ['scans', 'activity'],
  ])('keeps the old ?tab=%s link working and rewrites it to %s', async (old, slug) => {
    const { router } = await renderApp(`/admin/scanning?tab=${old}`, {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers,
    });
    await waitFor(() => expect(router.state.location.searchStr).toContain(`tab=${slug}`));
    expect(router.state.location.searchStr).not.toContain(`tab=${old}`);
  });

  it('falls back to Sessions on an unknown ?tab= and drops it from the URL', async () => {
    const { router } = await renderApp('/admin/scanning?tab=nope', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers,
    });
    expect(await screen.findByRole('tab', { name: 'Sessions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() => expect(router.state.location.searchStr).not.toContain('tab='));
  });

  it('closes an event creation draft when the console mode changes', async () => {
    await renderApp('/admin/scanning?tab=events', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: { ...handlers, '/api/v1/templates/eligible': empty },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'New event' }));
    expect(await screen.findByRole('dialog', { name: 'New event' })).toBeInTheDocument();
    act(() => setMode('test'));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New event' })).not.toBeInTheDocument(),
    );
  });

  it('keeps scan details read-only and closes them when the organization changes', async () => {
    const { router } = await renderApp('/admin/scanning?tab=activity', {
      session: 'admin',
      memberships: [
        readOnly,
        membershipFixture('o2', { capabilities: ['org:read', 'scanning:read'] }),
      ],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/scans': (url) =>
          json({
            items: url.searchParams.get('orgId') === 'o1' ? [scanRecord] : [],
            nextCursor: null,
          }),
      },
    });
    const row = (await screen.findByText('Anna')).closest('tr');
    expect(row).not.toBeNull();
    await userEvent.setup().click(within(row as HTMLElement).getByRole('button'));
    const sheet = await screen.findByRole('dialog', { name: 'Scan' });
    expect(within(sheet).getByRole('heading', { name: 'Anna' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Undo check-in' })).not.toBeInTheDocument();
    await act(async () => {
      await router.navigate({ to: '/admin/scanning', search: { orgId: 'o2', tab: 'activity' } });
    });
    expect(await screen.findByText('No scans yet')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Scan' })).not.toBeInTheDocument();
    expect(screen.queryByText('Anna')).not.toBeInTheDocument();
  });

  it('allows a pass operator to undo without scanning management permission', async () => {
    await renderApp('/admin/scanning?tab=activity', {
      session: 'user',
      memberships: [
        membershipFixture('o1', {
          roles: ['pass_operator'],
          capabilities: ['org:read', 'scanning:read', 'passes:read', 'passes:operate'],
        }),
      ],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/scans': () => json({ items: [scanRecord], nextCursor: null }),
      },
    });
    const row = (await screen.findByText('Anna')).closest('tr');
    expect(row).not.toBeNull();
    await userEvent.setup().click(within(row as HTMLElement).getByRole('button'));
    const sheet = await screen.findByRole('dialog', { name: 'Scan' });
    expect(within(sheet).getByRole('button', { name: 'Undo check-in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New session' })).not.toBeInTheDocument();
  });

  it('shows the empty sessions tab without a header action', async () => {
    const { container } = await renderApp('/admin/scanning', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers,
    });
    expect(await screen.findByRole('heading', { name: 'Scanning', level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());
    expect(
      await screen.findByRole('heading', { name: 'Set up scanning', level: 2 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it.each([
    ['events', 'No events yet'],
    ['staff', 'No staff yet'],
    ['scans', 'No scans yet'],
  ])('renders the %s tab with its empty state', async (tab, title) => {
    const { container } = await renderApp(`/admin/scanning?tab=${tab}&orgId=o1`, {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers,
    });
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('keeps the filters in the URL when the tab changes', async () => {
    const { router } = await renderApp(
      '/admin/scanning?tab=activity&scannerId=s1&outcome=refused&orgId=o1',
      { session: 'admin', memberships: [northwind], selectedOrg: 'o1', handlers },
    );
    await screen.findByText('No scans yet');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Events' }));
    await screen.findByText('No events yet');
    expect(router.state.location.search).toMatchObject({
      tab: 'events',
      scannerId: 's1',
      outcome: 'refused',
    });
    expect(router.state.location.pathname).toBe('/admin/o/o1/scanning');
  });

  it('leaves the default tab out of the URL', async () => {
    const { router } = await renderApp('/admin/scanning?tab=staff&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers,
    });
    await screen.findByText('No staff yet');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Sessions' }));
    await screen.findByRole('heading', { name: 'Set up scanning', level: 2 });
    expect(router.state.location.search).not.toHaveProperty('tab');
  });

  it('ignores an unknown tab', async () => {
    await renderApp('/admin/scanning?tab=nope', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers,
    });
    await waitFor(() => expect(screen.queryByRole('tablist')).toBeNull());
    expect(
      await screen.findByRole('heading', { name: 'Set up scanning', level: 2 }),
    ).toBeInTheDocument();
  });

  it('links the event page back to Scanning with typed routes', async () => {
    await renderApp('/admin/scanning/events/e1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers,
    });
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    const link = within(crumbs).getByRole('link', { name: 'Scanning' });
    const destination = new URL(link.getAttribute('href') ?? '', 'https://wallet.test');
    expect(destination.pathname).toBe('/admin/scanning');
  });
});

describe('links to /scan', () => {
  it('are plain anchors: /scan is its own document', () => {
    render(<ScanLink event="e1">Open scanner</ScanLink>);
    const link = screen.getByRole('link', { name: 'Open scanner' });
    expect(link).toHaveAttribute('href', '/scan?event=e1');
  });

  it('never go through the router', () => {
    const dir = join(process.cwd(), 'src/web/admin/scanning');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        if (statSync(p).isDirectory()) return walk(p);
        return /\.tsx?$/.test(n) && !n.includes('.test.') ? [p] : [];
      });
    for (const path of walk(dir)) {
      const text = readFileSync(path, 'utf8');
      expect(text, path).not.toMatch(/\bto[=:]\s*\{?['"]\/scan(['"?#/])/);
    }
  });
});
