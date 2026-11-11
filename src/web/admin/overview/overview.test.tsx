import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import {
  json,
  membershipFixture,
  problem,
  renderApp,
  sessionFixture,
} from '@/web/lib/test-utils.tsx';
import { audit, memoryStorage, ok, overview, status } from './overview-fixtures.ts';

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
});

const org = (id: string, name: string) => ({
  id,
  slug: id,
  name,
  status: 'active',
  createdAt: 1,
  counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
  countsCapped: false,
});

describe('overview page', () => {
  it('puts an expiring signing identity in the focus card with a link to review identities', async () => {
    const DAY = 86_400_000;
    await renderApp('/admin', {
      session: 'admin',
      memberships: [],
      handlers: {
        ...ok,
        '/api/v1/identities': () =>
          json({
            items: [
              {
                id: 'i1',
                orgId: null,
                label: 'Harbor signer',
                passTypeIdentifier: 'pass.test',
                teamIdentifier: 'TEAM',
                source: 'db',
                certSha256: null,
                certSubject: null,
                certSerial: null,
                notBefore: 1_600_000_000_000,
                notAfter: Date.now() + 5 * DAY,
                daysRemaining: 5,
                apnsBinding: null,
                apnsAvailable: false,
                apnsHealth: 'unknown',
                nfcEnabled: false,
                isDefault: true,
                createdAt: 1_600_000_000_000,
              },
            ],
            nextCursor: null,
          }),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'One Apple signing identity needs attention' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Harbor signer: certificate is nearing expiry.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review identities' })).toHaveAttribute(
      'href',
      '/admin/identities',
    );
  });

  it('renders linked totals, charts, health and activity without a11y violations', async () => {
    const { container } = await renderApp('/admin', {
      session: 'admin',
      memberships: [],
      handlers: ok,
    });
    const totals = await screen.findByRole('list', { name: 'Totals' });
    const directories = screen.getByRole('region', { name: 'Platform directories' });
    expect(within(directories).getByText('2')).toBeInTheDocument();
    expect(within(directories).getByRole('link', { name: 'View organizations' })).toHaveAttribute(
      'href',
      '/admin/orgs',
    );
    expect(within(directories).getByRole('link', { name: 'View accounts' })).toHaveAttribute(
      'href',
      '/admin/users',
    );
    expect(within(directories).getByRole('link', { name: 'View identities' })).toHaveAttribute(
      'href',
      '/admin/identities',
    );
    expect(screen.getByText('Metrics: All organizations · Live mode')).toBeInTheDocument();
    expect(screen.getByText('Administrative activity · not filtered by mode')).toBeInTheDocument();
    expect(await screen.findAllByText('Ada · Platform')).toHaveLength(2);
    expect(within(totals).getByText('1,200')).toBeInTheDocument();
    expect(within(totals).getByRole('link', { name: /^Passes\s+1,200$/ })).toHaveAttribute(
      'href',
      '/admin/passes',
    );
    expect(within(totals).getByRole('link', { name: /Passes with holder email/ })).toHaveAttribute(
      'href',
      '/admin/passes',
    );
    expect(screen.getByRole('link', { name: /Voided/ })).toHaveAttribute(
      'href',
      '/admin/passes?status=voided',
    );
    expect(screen.getByRole('img', { name: /Issued: 6 total, peak 3/ })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Box office feed' })).toHaveAttribute(
      'href',
      '/admin/connections/c1',
    );
    expect(
      within(screen.getByRole('list', { name: 'Needs attention' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    expect(await screen.findByRole('link', { name: /Pass voided\s*Clara Rossi/ })).toHaveAttribute(
      'href',
      '/admin/passes/p1',
    );
    expect(screen.getByRole('link', { name: /Settings updated/ })).toHaveAttribute(
      'href',
      '/admin/audit?entry=2',
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  it('does not reuse a previous principal’s platform metrics', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const nextMetrics = deferred.withResolvers<Response>();
    let requests = 0;
    const { queryClient } = await renderApp('/admin', {
      session: 'admin',
      memberships: [],
      handlers: {
        ...ok,
        '/api/v1/metrics/platform/overview': () =>
          ++requests === 1 ? json(overview()) : nextMetrics.promise,
      },
    });
    const totals = await screen.findByRole('list', { name: 'Totals' });
    expect(within(totals).getByText('1,200')).toBeInTheDocument();
    const nextSession = sessionFixture('admin');
    if (!nextSession.authenticated) throw new Error('Expected an authenticated session fixture.');
    act(() => {
      queryClient.setQueryData(['session'], {
        ...nextSession,
        user: { ...nextSession.user, id: 'u2' },
      });
    });
    await waitFor(() => {
      expect(requests).toBe(2);
      expect(screen.queryByRole('list', { name: 'Totals' })).toBeNull();
    });
    nextMetrics.resolve(
      json(
        overview({
          totals: { ...overview().totals, passes: 45 },
        }),
      ),
    );
    expect(
      within(await screen.findByRole('list', { name: 'Totals' })).getByText('45'),
    ).toBeInTheDocument();
    act(() => {
      queryClient.setQueryData(['session'], {
        ...nextSession,
        user: { ...nextSession.user, id: 'u3' },
        roles: ['user'],
      });
    });
    expect(await screen.findByText('You do not have access')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Totals' })).toBeNull();
    expect(requests).toBe(2);
  });

  it('shows unknown email outcomes as needing review, separately from failures', async () => {
    await renderApp('/admin', {
      session: 'admin',
      handlers: {
        ...ok,
        '/api/v1/metrics/platform/overview': () =>
          json(overview({ totals: { ...overview().totals, emailUnknown: 4, emailFailures: 2 } })),
      },
    });
    const counts = await screen.findByRole('list', { name: 'More counts' });
    const unknown = within(counts).getByText(/Email outcomes: Unknown \(needs review\)/);
    expect(within(unknown).getByText('4')).toBeInTheDocument();
    expect(unknown).not.toHaveTextContent(/failed|delivered/i);
  });

  it('asks for the range and hides sign-ins from activity', async () => {
    const { fetchMock } = await renderApp('/admin?range=30d', { session: 'admin', handlers: ok });
    await screen.findByRole('list', { name: 'Totals' });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.find((u) => u.includes('/api/v1/metrics/platform/overview'))).toContain(
      'range=30d',
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/v1/audit/platform')),
      ).toBe(true),
    );
    const call = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes('/api/v1/audit/platform'));
    expect(call).toContain('excludeAction=auth.');
    expect(call).toContain('limit=6');
  });

  it('labels D1 numbers approximate and toggles the data tables', async () => {
    await renderApp('/admin', {
      session: 'admin',
      handlers: {
        ...ok,
        '/api/v1/metrics/platform/overview': () =>
          json(overview({ source: 'd1', unavailable: ['downloads'] })),
      },
    });
    expect(await screen.findByText('Approximate')).toBeInTheDocument();
    expect(screen.getByText('Not available')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show data' });
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('table', { name: 'Issued' })).toBeInTheDocument();
  });

  it('keeps health and activity when metrics fail', async () => {
    await renderApp('/admin', {
      session: 'admin',
      handlers: { ...ok, '/api/v1/metrics/platform/overview': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
    expect(await screen.findByText('Box office feed')).toBeInTheDocument();
  });

  it('shows unknown health and the activity art when there is no data', async () => {
    const { container } = await renderApp('/admin', {
      session: 'admin',
      handlers: {
        ...ok,
        '/api/v1/status': () => json({ ...status, overall: 'verified', components: [] }),
        '/api/v1/audit/platform': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByText('No status checks reported')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText('All good')).not.toBeInTheDocument();
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
    expect(container.querySelector('[data-art="activity"]')).not.toBeNull();
  });

  it('keeps platform metrics and activity global despite tenant scope, including range changes', async () => {
    const storage = memoryStorage();
    storage.setItem('wallet-org-filter', 'o1');
    vi.stubGlobal('localStorage', storage);
    // The test runtime is Node 24; ES2023 is the web build's type-library target.
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const nextRange = deferred.withResolvers<Response>();
    const metricsRequests: URL[] = [];
    const auditRequests: URL[] = [];
    const { router } = await renderApp('/admin?range=30d', {
      session: 'admin',
      memberships: [membershipFixture('o1')],
      handlers: {
        ...ok,
        '/api/v1/orgs': () =>
          json({ items: [org('o1', 'North'), org('o2', 'South')], nextCursor: null }),
        '/api/v1/metrics/platform/overview': (url) => {
          metricsRequests.push(url);
          if (url.searchParams.has('orgId')) return json(overview({ range: '24h' }));
          return url.searchParams.get('range') === '24h'
            ? nextRange.promise
            : json(overview({ range: '30d' }));
        },
        '/api/v1/audit/platform': (url) => {
          auditRequests.push(url);
          return json(audit);
        },
      },
    });
    expect(await screen.findByText('Metrics: All organizations · Live mode')).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Totals' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Pass voided/ })).toBeInTheDocument();
    const activityHeader = screen.getByRole('heading', { name: 'Recent activity' }).parentElement!;
    expect(within(activityHeader).getByRole('link', { name: 'Audit log' })).toHaveAttribute(
      'href',
      '/admin/audit',
    );
    expect(screen.getByRole('link', { name: /Settings updated/ })).toHaveAttribute(
      'href',
      '/admin/audit?entry=2',
    );
    expect(storage.getItem('wallet-org-filter')).toBe('o1');
    expect(metricsRequests[0]?.searchParams.has('orgId')).toBe(false);
    expect(auditRequests[0]?.searchParams.has('orgId')).toBe(false);
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /^Range:/ }));
    await user.click(await screen.findByRole('option', { name: 'Last 24 hours' }));
    await waitFor(() => expect(router.state.location.search.range).toBe('24h'));
    expect(
      await screen.findByText('Updating metrics. Showing last 30 days until they arrive.'),
    ).toBeInTheDocument();
    nextRange.resolve(
      json(
        overview({
          range: '24h',
          totals: {
            ...overview().totals,
            passes: 45,
            activePasses: 40,
            voidedPasses: 5,
            holders: 30,
          },
        }),
      ),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Totals' })).getByText('45'),
      ).toBeInTheDocument(),
    );
    expect(metricsRequests.every((url) => !url.searchParams.has('orgId'))).toBe(true);
    expect(auditRequests.every((url) => !url.searchParams.has('orgId'))).toBe(true);
    await user.click(screen.getByRole('combobox', { name: 'Platform organization filter' }));
    await user.click(await screen.findByRole('option', { name: 'South' }));
    await waitFor(() => expect(router.state.location.search.filterOrgId).toBe('o2'));
    await waitFor(() =>
      expect(metricsRequests.some((url) => url.searchParams.get('orgId') === 'o2')).toBe(true),
    );
    expect(storage.getItem('wallet-org-filter')).toBe('o1');
  });

  it('honors a platform organization deep link without membership and scopes activity links', async () => {
    const metricsRequests: URL[] = [];
    const auditRequests: URL[] = [];
    await renderApp('/admin?filterOrgId=o2&range=30d', {
      session: 'admin',
      memberships: [],
      handlers: {
        ...ok,
        '/api/v1/orgs': () =>
          json({ items: [org('o1', 'North'), org('o2', 'South')], nextCursor: null }),
        '/api/v1/metrics/platform/overview': (url) => {
          metricsRequests.push(url);
          return json(
            overview({
              range: '30d',
              setup: { ...overview().setup, orgs: 1, passEmailsSent: 0, latestPassId: null },
            }),
          );
        },
        '/api/v1/audit/platform': (url) => {
          auditRequests.push(url);
          return json(audit);
        },
      },
    });
    expect(await screen.findByText('Metrics: South · Live mode')).toBeInTheDocument();
    const directories = await screen.findByRole('region', { name: 'Platform directories' });
    expect(
      within(directories).getByRole('heading', { name: 'Organizations · filtered · all modes' }),
    ).toBeInTheDocument();
    expect(await within(directories).findByText('1')).toBeInTheDocument();
    expect(
      await screen.findByText('Organization setup · Live passes and emails for South'),
    ).toBeInTheDocument();
    const checklist = screen.getByRole('region', { name: 'Get started' });
    const send = new URL(
      within(checklist).getByRole('link', { name: 'Send email' }).getAttribute('href')!,
      'http://localhost',
    );
    expect(send.pathname).toBe('/admin/passes');
    expect(metricsRequests[0]?.searchParams.get('orgId')).toBe('o2');
    await screen.findByRole('link', { name: /Settings updated/ });
    expect(auditRequests[0]?.searchParams.get('orgId')).toBe('o2');
    const activityHeader = screen.getByRole('heading', { name: 'Recent activity' }).parentElement!;
    const auditLink = new URL(
      within(activityHeader).getByRole('link', { name: 'Audit log' }).getAttribute('href')!,
      'http://localhost',
    );
    expect(auditLink.pathname).toBe('/admin/audit');
    expect(auditLink.searchParams.get('filterOrgId')).toBe('o2');
    const entryLink = new URL(
      screen.getByRole('link', { name: /Settings updated/ }).getAttribute('href')!,
      'http://localhost',
    );
    expect(entryLink.searchParams.get('filterOrgId')).toBe('o2');
    expect(entryLink.searchParams.get('entry')).toBe('2');
  });

  it('preserves scalar organization IDs from deep links when changing the range', async () => {
    const id = '9007199254740993';
    const requests: URL[] = [];
    await renderApp(`/admin?filterOrgId=${id}&range=30d`, {
      session: 'admin',
      memberships: [],
      handlers: {
        ...ok,
        '/api/v1/orgs': () => json({ items: [org(id, 'Numeric organization')], nextCursor: null }),
        '/api/v1/metrics/platform/overview': (url) => {
          requests.push(url);
          return json(overview({ range: url.searchParams.get('range') }));
        },
      },
    });
    expect(
      await screen.findByText('Metrics: Numeric organization · Live mode'),
    ).toBeInTheDocument();
    await screen.findByRole('list', { name: 'Totals' });
    expect(requests[0]?.searchParams.get('orgId')).toBe(id);
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /^Range:/ }));
    await user.click(await screen.findByRole('option', { name: 'Last 24 hours' }));
    await waitFor(() =>
      expect(
        requests.some(
          (url) => url.searchParams.get('range') === '24h' && url.searchParams.get('orgId') === id,
        ),
      ).toBe(true),
    );
  });

  it('changes and clears the platform filter without reusing another organization’s data', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const nextMetrics = deferred.withResolvers<Response>();
    const nextAudit = deferred.withResolvers<Response>();
    const metricsRequests: URL[] = [];
    const auditRequests: URL[] = [];
    const north = org('o1', 'North');
    const south = org('o2', 'South');
    const { router } = await renderApp('/admin?range=30d', {
      session: 'admin',
      memberships: [],
      handlers: {
        ...ok,
        '/api/v1/orgs': (url) => {
          if (url.searchParams.get('limit') === '200')
            return json({ items: [north, south], nextCursor: null });
          return url.searchParams.get('cursor') === 'next'
            ? json({ items: [south], nextCursor: null })
            : json({ items: [north], nextCursor: 'next' });
        },
        '/api/v1/metrics/platform/overview': (url) => {
          metricsRequests.push(url);
          const id = url.searchParams.get('orgId');
          const range = url.searchParams.get('range') ?? '7d';
          if (id === 'o2' && range === '30d') return nextMetrics.promise;
          return json(
            overview({
              range,
              setup: { ...overview().setup, orgs: id ? 1 : 2 },
              totals: { ...overview().totals, passes: id === 'o1' ? 100 : id === 'o2' ? 45 : 1200 },
            }),
          );
        },
        '/api/v1/audit/platform': (url) => {
          auditRequests.push(url);
          return url.searchParams.get('orgId') === 'o2' ? nextAudit.promise : json(audit);
        },
      },
    });
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'Totals' });
    await screen.findByRole('link', { name: /Pass voided/ });
    await user.click(screen.getByRole('combobox', { name: 'Platform organization filter' }));
    await user.click(await screen.findByRole('option', { name: 'North' }));
    await waitFor(() => expect(router.state.location.search.filterOrgId).toBe('o1'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Totals' })).getByText('100'),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(auditRequests.some((url) => url.searchParams.get('orgId') === 'o1')).toBe(true),
    );
    await user.click(screen.getByRole('button', { name: 'Load more organizations' }));
    await user.click(screen.getByRole('combobox', { name: 'Platform organization filter' }));
    await user.click(await screen.findByRole('option', { name: 'South' }));
    await waitFor(() => expect(router.state.location.search.filterOrgId).toBe('o2'));
    expect(screen.queryByRole('list', { name: 'Totals' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Pass voided/ })).toBeNull();
    const directories = screen.getByRole('region', { name: 'Platform directories' });
    expect(within(directories).getByText('Loading count…')).toBeInTheDocument();
    nextMetrics.resolve(
      json(
        overview({
          range: '30d',
          setup: { ...overview().setup, orgs: 1 },
          totals: { ...overview().totals, passes: 45 },
        }),
      ),
    );
    nextAudit.resolve(json({ items: [], nextCursor: null }));
    expect(
      within(await screen.findByRole('list', { name: 'Totals' })).getByText('45'),
    ).toBeInTheDocument();
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: /^Range:/ }));
    await user.click(await screen.findByRole('option', { name: 'Last 24 hours' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ filterOrgId: 'o2', range: '24h' }),
    );
    await user.click(screen.getByRole('button', { name: 'Clear organization filter' }));
    await waitFor(() => {
      expect(router.state.location.search.filterOrgId).toBeUndefined();
      expect(router.state.location.search.range).toBe('24h');
    });
    await waitFor(() =>
      expect(
        metricsRequests.some(
          (url) => !url.searchParams.has('orgId') && url.searchParams.get('range') === '24h',
        ),
      ).toBe(true),
    );
    expect(screen.getByText('Metrics: All organizations · Live mode')).toBeInTheDocument();
  });
});

describe('get started', () => {
  const empty = {
    orgs: 0,
    assignedTemplates: 0,
    passes: 0,
    passEmailsSent: 0,
    latestPassId: null,
    scanners: 0,
  };
  const zero = (s: Record<string, unknown>) =>
    overview({
      setup: { ...empty, ...s },
      totals: { ...overview().totals, passes: 0, activePasses: 0, holders: 0, pushFailures: 0 },
    });

  it('keeps Test metrics visible when only the Live setup checklist is empty', async () => {
    setMode('test');
    await renderApp('/admin', {
      session: 'admin',
      handlers: {
        ...ok,
        '/api/v1/metrics/platform/overview': () =>
          json(
            overview({
              setup: { ...empty, orgs: 1, assignedTemplates: 1 },
              totals: {
                ...overview().totals,
                passes: 42,
                activePasses: 40,
                voidedPasses: 2,
                holders: 30,
              },
            }),
          ),
      },
    });
    const totals = await screen.findByRole('list', { name: 'Totals' });
    expect(within(totals).getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Metrics: All organizations · Test mode')).toBeInTheDocument();
    expect(
      screen.getByText('Platform setup · Live passes and emails across all organizations'),
    ).toBeInTheDocument();
  });

  it('replaces the charts with four steps that check themselves', async () => {
    const { container } = await renderApp('/admin', {
      session: 'admin',
      handlers: { ...ok, '/api/v1/metrics/platform/overview': () => json(zero({ orgs: 1 })) },
    });
    const list = await screen.findByRole('region', { name: 'Get started' });
    const steps = within(list).getAllByRole('listitem');
    expect(steps).toHaveLength(4);
    expect(steps[0]).toHaveTextContent('(done)');
    expect(steps[1]).not.toHaveTextContent('(done)');
    expect(within(list).getByRole('link', { name: 'Templates' })).toHaveAttribute(
      'href',
      '/admin/templates',
    );
    expect(within(list).getByRole('link', { name: 'New pass' })).toHaveAttribute(
      'href',
      '/admin/passes/new',
    );
    expect(screen.queryByRole('img', { name: /Issued/ })).not.toBeInTheDocument();
    // Before the first pass the checklist leads: no zero tiles, no range.
    expect(screen.queryByRole('combobox', { name: 'Range' })).not.toBeInTheDocument();
    expect(screen.queryByText('Push failures')).not.toBeInTheDocument();
    // One active art: the current step's; the done one holds still, the activity art is static.
    expect(container.querySelector('[data-art="template"]')).not.toHaveAttribute('data-still');
    expect(container.querySelector('[data-art="building"]')).toHaveAttribute('data-still');
    expect(container.querySelector('[data-art="passes"]')).toHaveAttribute('data-still');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('sends step four to the newest pass holder tab, and goes once an email is sent', async () => {
    let sent = 0;
    const { queryClient } = await renderApp('/admin', {
      session: 'admin',
      handlers: {
        ...ok,
        '/api/v1/metrics/platform/overview': () =>
          json(
            zero({
              orgs: 1,
              assignedTemplates: 1,
              passes: 1,
              latestPassId: 'p7',
              passEmailsSent: sent,
            }),
          ),
      },
    });
    const list = await screen.findByRole('region', { name: 'Get started' });
    expect(within(list).getByRole('link', { name: 'Send email' })).toHaveAttribute(
      'href',
      '/admin/passes/p7?tab=holder',
    );
    // With a pass issued the charts are back, under the checklist.
    expect(screen.getByRole('img', { name: /Issued/ })).toBeInTheDocument();
    sent = 1;
    await queryClient.invalidateQueries({ queryKey: ['metrics'] });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull());
    expect(screen.getByRole('img', { name: /Issued/ })).toBeInTheDocument();
  });

  it('stays dismissed for this viewer', async () => {
    const handlers = { ...ok, '/api/v1/metrics/platform/overview': () => json(zero({})) };
    const first = await renderApp('/admin', { session: 'admin', handlers });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
    first.unmount();
    await renderApp('/admin', { session: 'admin', handlers });
    expect(await screen.findByRole('img', { name: /Issued/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
  });
});
