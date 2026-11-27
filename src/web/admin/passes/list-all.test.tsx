import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, membershipFixture, problem, renderApp } from '../../lib/test-utils.tsx';
import { passSummary } from './test-fixtures.ts';

const north = membershipFixture('o1', { orgName: 'Northwind' });
const harbor = membershipFixture('o2', { orgName: 'Harbor' });
const personal = membershipFixture('o3', { orgName: 'Personal', personal: true });
const sandbox = membershipFixture('o4', { orgName: 'Sandbox', testOnly: true });
const memberships = [north, harbor, personal];

// 1_700_000_000_000 is Nov 14 22:13 UTC: already the 15th in Auckland, still the 14th in Los Angeles.
const northRow = passSummary({
  id: 'p1',
  orgId: 'o1',
  title: 'Sam Jones',
  orgName: 'Northwind',
  templateName: 'Member',
  timeZone: 'America/Los_Angeles',
});
const harborRow = passSummary({
  id: 'p2',
  orgId: 'o2',
  title: 'Ana Reyes',
  orgName: 'Harbor',
  templateName: 'Ferry',
  timeZone: 'Pacific/Auckland',
});
const quiet = {
  '/api/v1/passes/views': () => json({ items: [], revision: 0 }),
  '/api/v1/passes/bulk-runs/current': () => json({}),
};
const page = (items: unknown[], extra: Record<string, unknown> = {}) =>
  json({ items, nextCursor: null, count: items.length, ...extra });

async function open(
  path: string,
  list: (url: URL) => Response = () => page([northRow, harborRow]),
  who = memberships,
) {
  const seen: URL[] = [];
  const app = await renderApp(path, {
    session: 'user',
    memberships: who,
    handlers: {
      ...quiet,
      '/api/v1/passes': (url) => {
        seen.push(url);
        return list(url);
      },
    },
  });
  return { ...app, seen };
}

describe('the All organizations passes list', () => {
  it('asks for orgId=all and caches apart from an organization list', async () => {
    const { seen, queryClient } = await open('/admin/all/passes');
    await screen.findByRole('link', { name: 'Sam Jones' });
    expect(seen[0]?.searchParams.get('orgId')).toBe('all');
    expect(seen[0]?.searchParams.get('count')).toBe('true');
    const keys = queryClient
      .getQueryCache()
      .findAll({ queryKey: ['admin', 'passes', 'list'] })
      .map((q) => q.queryKey);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.[3]).toMatchObject({ orgId: 'all' });
  });

  it('is read-only: no checkboxes, row menu, bulk bar or create buttons', async () => {
    await open('/admin/all/passes');
    await screen.findByRole('link', { name: 'Sam Jones' });
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /actions/i })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
    for (const name of ['New pass', 'Import', 'Photos']) {
      expect(screen.queryByRole('link', { name })).toBeNull();
    }
    expect(screen.getByRole('heading', { name: 'Passes' })).toBeInTheDocument();
  });

  it('shows each row with its organization chip and template', async () => {
    await open('/admin/all/passes');
    await screen.findByRole('link', { name: 'Sam Jones' });
    expect(screen.getAllByTitle('Northwind').length).toBeGreaterThan(0);
    expect(screen.getAllByTitle('Harbor').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Ferry').length).toBeGreaterThan(0);
  });

  it("opens a row in the row's own organization and remembers the list", async () => {
    const user = userEvent.setup();
    const { router } = await open('/admin/all/passes?status=active');
    const link = await screen.findByRole('link', { name: 'Ana Reyes' });
    expect(link).toHaveAttribute('href', '/admin/o/o2/passes/p2');
    await user.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/o/o2/passes/p2'));
    expect(router.state.location.state).toMatchObject({
      returnTo: '/admin/all/passes?status=active',
    });
  });

  it("dates each row in its organization's zone", async () => {
    await open('/admin/all/passes');
    const harborCells = (await screen.findByRole('link', { name: 'Ana Reyes' })).closest('tr');
    const northCells = screen.getByRole('link', { name: 'Sam Jones' }).closest('tr');
    expect(within(harborCells as HTMLElement).getByText('Nov 15, 2023')).toBeInTheDocument();
    expect(within(northCells as HTMLElement).getByText('Nov 14, 2023')).toBeInTheDocument();
  });

  it('drops a row of an organization the person cannot read', async () => {
    const stray = passSummary({ id: 'p9', orgId: 'o9', title: 'Stray Pass', orgName: 'Elsewhere' });
    await open('/admin/all/passes', () => page([northRow, stray, harborRow]));
    await screen.findByRole('link', { name: 'Sam Jones' });
    expect(screen.queryByText('Stray Pass')).toBeNull();
  });

  it('keeps a sandbox out of the list and the organization filter', async () => {
    const user = userEvent.setup();
    await open('/admin/all/passes', undefined, [...memberships, sandbox]);
    await user.click(await screen.findByRole('button', { name: /^Organization:/ }));
    expect(await screen.findByRole('checkbox', { name: /Harbor/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Sandbox/ })).toBeNull();
  });

  it('narrows by organization with orgIds, and offers no template or connection filter', async () => {
    const user = userEvent.setup();
    const { seen } = await open('/admin/all/passes');
    await screen.findByRole('link', { name: 'Sam Jones' });
    expect(screen.queryByRole('combobox', { name: /^Template/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /^Connection/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Organization:/ }));
    await user.click(await screen.findByRole('checkbox', { name: /Harbor/ }));
    await waitFor(() => expect(seen.some((u) => u.searchParams.get('orgIds') === 'o2')).toBe(true));
    expect(screen.getByRole('button', { name: 'Organization: Harbor' })).toBeInTheDocument();
  });

  it('says there are no passes without an action', async () => {
    await open('/admin/all/passes', () => page([]));
    expect(await screen.findByText('No passes yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New pass' })).toBeNull();
  });

  it('offers to clear filters when they match nothing', async () => {
    await open('/admin/all/passes?status=voided', () => page([]));
    expect(await screen.findByText(/no .*match/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /clear/i }).length).toBeGreaterThan(0);
  });

  // The router reads a bare JSON-looking value as JSON, so string params are quoted.
  const quoted = (v: string) => encodeURIComponent(JSON.stringify(v));
  const email = quoted(JSON.stringify([{ k: '$email', o: 'is', v: 'a@b.co' }]));
  it.each([
    ['holder email chip', `m=${email}`],
    ['organization chip', 'orgIds=o2'],
    ['status', 'status=voided'],
    ['holder state', 'holderState=owned'],
    ['on device', `onDevice=${quoted('true')}`],
    ['scan', 'noScanDays=30'],
    ['free text', 'q=zz'],
  ])('shows the filtered empty state for the %s', async (_name, query) => {
    await open(`/admin/all/passes?${query}`, () => page([]));
    expect(await screen.findByText(/no .*match/i)).toBeInTheDocument();
    expect(screen.queryByText('No passes yet')).toBeNull();
  });

  it('shows the server message for too many organizations, with no retry', async () => {
    await open('/admin/all/passes', () =>
      problem(
        422,
        'ORG_SCOPE_TOO_WIDE',
        'You can read passes in more than 50 organizations. Filter by organization.',
      ),
    );
    expect(await screen.findByText(/more than 50 organizations/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again|retry/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^Organization:/ })).toBeInTheDocument();
  });

  it('shows the Live and Test switch, the Test tone and the announcer', async () => {
    const user = userEvent.setup();
    const { seen } = await open('/admin/all/passes');
    await screen.findByRole('link', { name: 'Sam Jones' });
    const bar = document.querySelector('[data-menubar]');
    expect(bar).not.toHaveAttribute('data-tone');
    await user.click(screen.getByRole('radio', { name: 'Test' }));
    expect(bar).toHaveAttribute('data-tone', 'test');
    expect(screen.getByText('Test mode on. New emails go to the Test inbox.')).toBeInTheDocument();
    await waitFor(() => expect(seen.length).toBeGreaterThan(1));
    expect(seen.at(-1)?.searchParams.get('orgId')).toBe('all');
    await user.click(screen.getByRole('radio', { name: 'Live' }));
    expect(bar).not.toHaveAttribute('data-tone');
  });

  it('does not send single-organization filters from the link', async () => {
    const { seen } = await open(
      '/admin/all/passes?templateId=t1&connectionId=c1&importId=i1&m=%5B%5D',
    );
    await screen.findByRole('link', { name: 'Sam Jones' });
    const q = seen[0]?.searchParams;
    for (const key of ['templateId', 'connectionId', 'importId', 'match']) {
      expect(q?.has(key)).toBe(false);
    }
    expect(screen.queryByText(/no .*match/i)).toBeNull();
  });

  it('goes to the chooser when no organization is readable', async () => {
    const { router } = await open('/admin/all/passes', undefined, [sandbox]);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
  });

  it('has no accessibility violations', async () => {
    const { container } = await open('/admin/all/passes');
    await screen.findByRole('link', { name: 'Sam Jones' });
    const result = await axe(container);
    expect(
      result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([]);
  });
});
