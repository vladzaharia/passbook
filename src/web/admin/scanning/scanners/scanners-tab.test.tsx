import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { managedSession } from '../sessions/test-fixtures.ts';
import { scannerFixture as s, templateFixture } from '../test-fixtures.ts';

const page = (items: unknown[]) => json({ items, nextCursor: null });
const none = () => page([]);
const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });

const scanners = [
  s({ id: 's1', name: 'Front door', lastSeenAt: Date.now() - 60_000, sessionId: 'session-1' }),
  s({ id: 's2', name: 'Side door', online: false, today: 0, lastSeenAt: Date.now() - 20 * 60_000 }),
  s({
    id: 's3',
    name: 'Till 2',
    status: 'not_paired',
    online: false,
    pairedAt: null,
    pairedLabel: null,
    lastSeenAt: null,
    accepts: { templateIds: ['t1', 't2'] },
  }),
  s({ id: 's4', name: 'Old gate', status: 'revoked', online: false }),
];

const handlers = (over: Record<string, never> = {}) => ({
  '/api/v1/scan-setups': (url: URL) => {
    const revoked = url.searchParams.get('status') === 'revoked';
    return page(revoked ? scanners.filter((x) => x.status === 'revoked') : scanners.slice(0, 3));
  },
  '/api/v1/scan-events': none,
  '/api/v1/scanning-sessions': () => page([managedSession]),
  '/api/v1/templates': () => page([templateFixture()]),
  ...over,
});

describe('Scanners tab', () => {
  it('lists scanners with status, accepts and the session each belongs to', async () => {
    const { container } = await renderApp('/admin/scanning?tab=devices&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: handlers(),
    });
    const table = await screen.findByRole('table', { name: 'Scanners' });
    expect(within(table).getByRole('link', { name: 'Front door' }).getAttribute('href')).toMatch(
      /^\/admin\/scanning\/scanners\/s1(\?|$)/,
    );
    expect(within(table).getAllByText('Safari on iPhone').length).toBeGreaterThan(0);
    expect(within(table).getByText('Online')).toBeInTheDocument();
    expect(within(table).getByText('Offline')).toBeInTheDocument();
    expect(within(table).getAllByText('Not paired')).toHaveLength(2);
    expect(within(table).getByText('2 templates')).toBeInTheDocument();
    expect(within(table).getAllByText('No PIN').length).toBeGreaterThan(0);
    expect(
      within(table).getByRole('link', { name: 'Membership desk' }).getAttribute('href'),
    ).toMatch(/\/scanning\/sessions\/session-1$/);
    expect(within(table).queryByRole('button')).toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('keeps revoked scanners behind Show revoked', async () => {
    await renderApp('/admin/scanning?tab=devices&orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: handlers(),
    });
    await screen.findByText('Side door');
    expect(screen.queryByText('Old gate')).toBeNull();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Show revoked (1)' }));
    expect(screen.getByText('Old gate')).toBeInTheDocument();
  });

  it('offers session creation when no devices are listed', async () => {
    await renderApp('/admin/scanning?tab=devices', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: { '/api/v1/scan-setups': none, '/api/v1/scan-events': none },
    });
    expect(await screen.findByText('No devices yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New session' })).toHaveLength(1);
  });
});

describe('device creation from Devices', () => {
  it('opens the shared-session form instead of creating an independent scanner setup', async () => {
    const { router } = await renderApp('/admin/scanning?tab=devices&orgId=o1&new=1', {
      session: 'admin',
      memberships: [northwind],
      selectedOrg: 'o1',
      handlers: handlers(),
    });
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    expect(
      within(dialog).getByRole('heading', { name: 'Name it and pick passes' }),
    ).toBeInTheDocument();
    const steps = within(dialog).getByRole('navigation', { name: 'Steps' });
    for (const title of ['Passes', 'Admission', 'Device defaults'])
      expect(within(steps).getByText(title)).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('new'));
  });
});
