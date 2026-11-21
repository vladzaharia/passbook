import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { newOrgFacts, readyFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { resetShownCounts } from './count.ts';
import { audit, memoryStorage, orgActivity, overview } from './overview-fixtures.ts';

const READER: OrgCapability[] = ['org:read', 'passes:read'];
const member = (capabilities: OrgCapability[] = [...READER, 'audit:read', 'passes:operate']) =>
  membershipFixture('o1', { orgName: 'Northwind', capabilities });

const emptySetup = {
  orgs: 1,
  assignedTemplates: 0,
  passes: 0,
  approvedTemplates: 0,
  releasedTemplates: 0,
  walletPasses: 0,
  passEmailsSent: 0,
  latestPassId: null,
  scanners: 0,
};
const calls = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  resetShownCounts();
});
afterEach(() => {
  resetModeForTests();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

const handlers = (activity: unknown = orgActivity()) => ({
  '/api/v1/metrics/activity': () => json(activity),
  '/api/v1/metrics/overview': () => json(overview({ setup: emptySetup })),
  '/api/v1/audit': () => json({ ...audit, items: audit.items.map((e) => ({ ...e, orgId: 'o1' })) }),
});

describe('organization overview', () => {
  it('shows a member only their organization, by template', async () => {
    const { fetchMock } = await renderApp('/admin', {
      session: 'user',
      memberships: [member()],
      selectedOrg: 'o1',
      handlers: handlers(),
    });
    expect(await screen.findByRole('heading', { name: 'Overview', level: 1 })).toBeInTheDocument();
    const totals = await screen.findByRole('list', { name: 'Totals' });
    for (const label of ['Issued', 'In a wallet', 'Removed', 'Scans', 'Redemptions']) {
      expect(
        within(totals).getByRole('link', { name: new RegExp(`^${label}`) }),
      ).toBeInTheDocument();
    }
    expect(within(totals).getByRole('link', { name: /^In a wallet\s+120$/ })).toHaveAttribute(
      'href',
      '/admin/passes?status=active&onDevice=%22true%22&orgId=o1',
    );
    const table = screen.getByRole('table', { name: 'Passes by template' });
    expect(within(table).getByRole('link', { name: 'Member card' })).toHaveAttribute(
      'href',
      '/admin/passes?templateId=t1&orgId=o1',
    );
    expect(within(table).getByText('Day pass')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Member card: 90 in a wallet, 10 not added' }),
    ).toBeInTheDocument();
    const urls = calls(fetchMock);
    expect(
      urls.some((u) => u.startsWith('/api/v1/metrics/activity?') && u.includes('orgId=o1')),
    ).toBe(true);
    // No platform surface: directories, platform metrics and the platform log stay unread.
    expect(
      urls.some((u) => /metrics\/platform|audit\/platform|\/api\/v1\/orgs\?|\/status/.test(u)),
    ).toBe(false);
    expect(screen.queryByRole('region', { name: 'Platform directories' })).toBeNull();
    expect(await screen.findByRole('list', { name: 'Recent activity' })).toBeInTheDocument();
  });

  it('shows the sandbox card, not Get started, for a developer org', async () => {
    await renderApp('/admin', {
      session: 'user',
      memberships: [{ ...member(), testOnly: true }],
      selectedOrg: 'o1',
      handlers: handlers(orgActivity({ templates: [] })),
    });
    expect(await screen.findByText('Developer sandbox')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Developers' })).toHaveAttribute(
      'href',
      '/developers',
    );
    expect(screen.queryByText('Get started')).toBeNull();
  });

  it('shows the organization counts as links to their lists', async () => {
    await renderApp('/admin', {
      session: 'user',
      memberships: [member([...READER, 'templates:read', 'integrations:read'])],
      selectedOrg: 'o1',
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1/workspace': () =>
          json({
            id: 'o1',
            slug: 'northwind',
            name: 'Northwind',
            status: 'active',
            defaultIdentityId: null,
            branding: {},
            createdAt: 1,
            updatedAt: 1,
            counts: { passes: 5, templates: 2, connections: 1, apiKeys: 3 },
            countsCapped: false,
          }),
      },
    });
    expect(await screen.findByRole('link', { name: /^2\s*templates/i })).toHaveAttribute(
      'href',
      '/admin/o/o1/templates',
    );
    expect(screen.getByRole('link', { name: /^3\s*API keys/i })).toHaveAttribute(
      'href',
      '/admin/o/o1/api-keys',
    );
  });

  it('asks for the selected range', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await renderApp('/admin?range=30d', {
      session: 'user',
      memberships: [member()],
      selectedOrg: 'o1',
      handlers: handlers(orgActivity({ range: '30d' })),
    });
    await screen.findByRole('list', { name: 'Totals' });
    expect(calls(fetchMock).some((u) => u.includes('range=30d'))).toBe(true);
    await user.click(screen.getByRole('combobox', { name: /^Range:/ }));
    await user.click(await screen.findByRole('option', { name: 'Last 24 hours' }));
    await waitFor(() =>
      expect(calls(fetchMock).some((u) => u.includes('activity') && u.includes('range=24h'))).toBe(
        true,
      ),
    );
  });

  it('opens Not added as the passes not on a device, and the no-scan filter', async () => {
    await renderApp('/admin', {
      session: 'user',
      memberships: [member()],
      selectedOrg: 'o1',
      handlers: handlers(),
    });
    const card = (await screen.findByRole('heading', { name: 'Not added yet' })).closest('div')
      ?.parentElement as HTMLElement;
    expect(within(card).getByText('18')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Email holders' })).toHaveAttribute(
      'href',
      '/admin/passes?status=active&onDevice=%22false%22&orgId=o1',
    );
    expect(within(card).getByRole('link', { name: 'No scan in 30 days' })).toHaveAttribute(
      'href',
      '/admin/passes?noScanDays=30&orgId=o1',
    );
  });

  it('follows capabilities: no operate, no audit', async () => {
    const { fetchMock } = await renderApp('/admin', {
      session: 'user',
      memberships: [member(READER)],
      selectedOrg: 'o1',
      handlers: handlers(),
    });
    expect(await screen.findByRole('link', { name: 'View passes' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Email holders' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Recent activity' })).toBeNull();
    expect(calls(fetchMock).some((u) => u.startsWith('/api/v1/audit'))).toBe(false);
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    expect(within(nav).getByRole('link', { name: 'Overview' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Audit log' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'API keys' })).toBeNull();
  });

  it('sends a member who cannot read passes to the first page their role opens', async () => {
    const { router, fetchMock } = await renderApp('/admin', {
      session: 'user',
      memberships: [
        membershipFixture('o1', {
          orgName: 'Northwind',
          capabilities: ['org:read', 'templates:read', 'templates:author'],
        }),
      ],
      handlers: { '/api/v1/templates': () => json({ items: [], nextCursor: null }) },
    });
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/admin\/o\/[^/]+\/templates$/),
    );
    expect(calls(fetchMock).filter((u) => u.includes('/metrics/'))).toEqual([]);
  });

  it('shows the buddy and the first-run checklist when there are no passes', async () => {
    await renderApp('/admin', {
      session: 'user',
      memberships: [member()],
      selectedOrg: 'o1',
      handlers: handlers(orgActivity({ templates: [] })),
    });
    expect(await screen.findByText('No passes yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New pass' })).toHaveAttribute(
      'href',
      '/admin/passes/new?orgId=o1',
    );
    expect(await screen.findByRole('region', { name: 'Get started' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Totals' })).toBeNull();
  });

  it('leads Get started with Brand and channels: the count and the first three to-dos', async () => {
    await renderApp('/admin', {
      session: 'user',
      memberships: [member()],
      selectedOrg: 'o1',
      handlers: {
        ...handlers(orgActivity({ templates: [] })),
        '/api/v1/orgs/o1/pass-setup': () => json(viewOf(newOrgFacts())),
      },
    });
    const list = await screen.findByRole('region', { name: 'Get started' });
    await within(list).findByText('Brand and channels');
    const steps = within(list).getAllByRole('listitem');
    expect(steps[0]).toHaveTextContent('Brand and channels');
    expect(steps[0]).toHaveTextContent('3 to do · Logo · Icon · Support');
    expect(within(steps[0] as HTMLElement).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/admin/o/o1/brand',
    );
    expect(steps[1]).toHaveTextContent('Use a blueprint');
    // A suggestion never gates: the blueprint step is still open, and the next waits on it as before.
    expect(within(steps[1] as HTMLElement).getByRole('link', { name: 'Blueprints' })).toBeVisible();
    expect(within(list).getAllByRole('button', { name: 'Needs step 2' })).toHaveLength(3);
  });

  it('checks the Brand step off once nothing is left to do', async () => {
    await renderApp('/admin', {
      session: 'user',
      memberships: [member()],
      selectedOrg: 'o1',
      handlers: {
        ...handlers(orgActivity({ templates: [] })),
        '/api/v1/orgs/o1/pass-setup': () => json(viewOf(readyFacts())),
      },
    });
    const list = await screen.findByRole('region', { name: 'Get started' });
    expect(await within(list).findByText('All set')).toBeInTheDocument();
    expect(within(list).getAllByText('(done)')).toHaveLength(1);
  });

  it('shows no Get started checklist in a developer sandbox', async () => {
    await renderApp('/admin', {
      session: 'user',
      memberships: [{ ...member(), testOnly: true }],
      selectedOrg: 'o1',
      handlers: handlers(orgActivity({ templates: [] })),
    });
    expect(await screen.findByText('No passes yet')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
  });

  it('hides New pass from a member who cannot operate passes', async () => {
    await renderApp('/admin', {
      session: 'user',
      memberships: [member(READER)],
      selectedOrg: 'o1',
      handlers: handlers(orgActivity({ templates: [] })),
    });
    expect(await screen.findByText('No passes yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New pass' })).toBeNull();
  });

  it('shows an error with a retry when the numbers do not load', async () => {
    const { problem } = await import('@/web/lib/test-utils.tsx');
    await renderApp('/admin', {
      session: 'user',
      memberships: [member(READER)],
      selectedOrg: 'o1',
      handlers: { '/api/v1/metrics/activity': () => problem(500, 'INTERNAL', 'Broken.') },
    });
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});

// jsdom has no layout: width sets the viewport the kit's media queries read, and the theme
// attribute is the one the toggle stamps. Colour contrast is covered by e2e (needs real paint).
const COMBOS = [1440, 820, 390].flatMap((width) =>
  (['light', 'dark'] as const).map((theme) => [width, theme] as const),
);

function viewport(width: number, theme: string) {
  document.documentElement.dataset.theme = theme;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

describe.each(COMBOS)('organization overview axe at %i, %s theme', (width, theme) => {
  it('with passes', async () => {
    viewport(width, theme);
    await renderApp('/admin', {
      session: 'user',
      memberships: [member()],
      selectedOrg: 'o1',
      handlers: handlers(),
    });
    await screen.findByRole('table', { name: 'Passes by template' });
    await screen.findByRole('list', { name: 'Recent activity' });
    expect((await axe(document.body)).violations).toEqual([]);
  });

  it('with no passes', async () => {
    viewport(width, theme);
    await renderApp('/admin', {
      session: 'user',
      memberships: [member()],
      selectedOrg: 'o1',
      handlers: handlers(orgActivity({ templates: [] })),
    });
    await screen.findByRole('region', { name: 'Get started' });
    expect((await axe(document.body)).violations).toEqual([]);
  });
});
