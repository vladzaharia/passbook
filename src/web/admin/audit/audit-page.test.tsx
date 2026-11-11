import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import {
  json,
  membershipFixture,
  problem,
  renderApp,
  sessionFixture,
} from '@/web/lib/test-utils.tsx';
import { REDACTED } from './redact.ts';

const entry = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  at: 1_700_000_000_000 + id,
  orgId: null,
  actorType: 'user',
  actorId: 'u1',
  actorLabel: 'Ada Lovelace',
  action: 'pass.void',
  targetType: 'pass',
  targetId: `p${id}`,
  targetLabel: `Pass ${id}`,
  requestId: 'req-1',
  detail: null,
  ...over,
});
const org = (id: string, name: string) => ({
  id,
  slug: id,
  name,
  status: 'active',
  defaultIdentityId: null,
  branding: {},
  createdAt: 1,
  updatedAt: 1,
  counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
  countsCapped: false,
});

const page =
  (items: unknown[], nextCursor: string | null = null) =>
  () =>
    json({ items, nextCursor });

function memoryStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}
const auditCalls = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/v1/audit/platform'));

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('audit page', () => {
  it('leads with the action label, links targets, keeps codes out of cells, accessible', async () => {
    const { container, fetchMock } = await renderApp('/admin/audit?action=pass.&from=100', {
      session: 'admin',
      handlers: { '/api/v1/audit/platform': page([entry(1)]) },
    });
    const table = await screen.findByRole('table', { name: 'Audit log' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers[0]).toBe('Action');
    expect(headers.at(-1)).toBe('Time');
    expect(screen.getByRole('combobox', { name: 'Action: pass. (prefix)' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Pass voided' })).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Pass 1' })).toHaveAttribute(
      'href',
      '/admin/passes/p1',
    );
    expect(within(table).getByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute(
      'href',
      '/admin/users/u1',
    );
    expect(table.querySelectorAll('td .font-mono, td code')).toHaveLength(0);
    expect(within(table).queryByText('pass.void')).toBeNull();
    const call = auditCalls(fetchMock)[0];
    expect(call).toContain('action=pass.');
    expect(call).toContain('from=100');
    expect((await axe(container)).violations).toEqual([]);
  });

  it('opens organization settings events in the distinct tenant workspace', async () => {
    await renderApp('/admin/audit', {
      session: 'admin',
      memberships: [],
      handlers: {
        '/api/v1/audit/platform': page([
          entry(1, { targetType: 'settings', targetId: 'org:o1', targetLabel: null }),
        ]),
      },
    });
    const link = await screen.findByRole('link', { name: 'Organization settings' });
    const url = new URL(link.getAttribute('href') ?? '', 'https://wallet.test');
    expect(url.pathname).toBe('/admin/orgs/o1');
    expect(url.searchParams.get('view')).toBe('workspace');
    expect(url.searchParams.get('orgId')).toBe('o1');
  });

  it('does not reuse a previous principal’s platform audit rows', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const nextAudit = deferred.withResolvers<Response>();
    let requests = 0;
    const { queryClient } = await renderApp('/admin/audit', {
      session: 'admin',
      memberships: [],
      handlers: {
        '/api/v1/audit/platform': () =>
          ++requests === 1 ? json({ items: [entry(1)], nextCursor: null }) : nextAudit.promise,
      },
    });
    expect(await screen.findByRole('link', { name: 'Pass 1' })).toBeInTheDocument();
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
      expect(screen.queryByRole('link', { name: 'Pass 1' })).toBeNull();
    });
    nextAudit.resolve(json({ items: [entry(2)], nextCursor: null }));
    expect(await screen.findByRole('link', { name: 'Pass 2' })).toBeInTheDocument();
    act(() => {
      queryClient.setQueryData(['session'], {
        ...nextSession,
        user: { ...nextSession.user, id: 'u3' },
        roles: ['user'],
      });
    });
    expect(await screen.findByText('You do not have access')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Pass 2' })).toBeNull();
    expect(requests).toBe(2);
  });

  it('does not show one organization’s rows under a different organization filter', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const nextAudit = deferred.withResolvers<Response>();
    const { router } = await renderApp('/admin/audit?filterOrgId=o1', {
      session: 'admin',
      memberships: [],
      handlers: {
        '/api/v1/orgs': () =>
          json({ items: [org('o1', 'North'), org('o2', 'South')], nextCursor: null }),
        '/api/v1/audit/platform': (url) =>
          url.searchParams.get('orgId') === 'o2'
            ? nextAudit.promise
            : json({ items: [entry(1, { orgId: 'o1' })], nextCursor: null }),
      },
    });
    const user = userEvent.setup();
    expect(await screen.findByRole('link', { name: 'Pass 1' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Filters (1)' }));
    const popover = await screen.findByRole('dialog');
    await user.click(within(popover).getByRole('combobox', { name: 'Organization' }));
    await user.click(await screen.findByRole('option', { name: 'South' }));
    await waitFor(() => expect(router.state.location.search.filterOrgId).toBe('o2'));
    expect(screen.queryByRole('link', { name: 'Pass 1' })).toBeNull();
    nextAudit.resolve(json({ items: [entry(2, { orgId: 'o2' })], nextCursor: null }));
    expect(await screen.findByRole('link', { name: 'Pass 2' })).toBeInTheDocument();
  });

  it('defaults to all organizations even with a remembered tenant selection', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'wallet-org-filter': 'o-north' }));
    const { fetchMock, router } = await renderApp('/admin/audit', {
      session: 'admin',
      memberships: [membershipFixture('o-north')],
      handlers: { '/api/v1/audit/platform': page([entry(1, { orgId: 'o-north' })]) },
    });
    await screen.findByRole('table', { name: 'Audit log' });
    expect(auditCalls(fetchMock)[0]).not.toContain('orgId=');
    expect(router.state.location.search.filterOrgId).toBeUndefined();
    expect(screen.getByText('Organization filter: All organizations')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Organization' })).toBeInTheDocument();
  });

  it('preserves the organization filter through filtering, entry navigation and clearing', async () => {
    const { router, fetchMock } = await renderApp('/admin/audit?filterOrgId=o-north', {
      session: 'admin',
      memberships: [],
      handlers: { '/api/v1/audit/platform': page([entry(1, { orgId: 'o-north' })]) },
    });
    const user = userEvent.setup();
    await screen.findByRole('table', { name: 'Audit log' });
    expect(auditCalls(fetchMock)[0]).toContain('orgId=o-north');
    expect(
      fetchMock.mock.calls.some(([url]) => /^\/api\/v1\/audit(?:\?|$)/.test(String(url))),
    ).toBe(false);
    expect(screen.queryByRole('columnheader', { name: 'Organization' })).toBeNull();
    expect(screen.getByText('Organization filter: o-north')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: /^Action/ }));
    await user.click(await screen.findByRole('option', { name: 'Pass voided' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        filterOrgId: 'o-north',
        action: 'pass.void',
      }),
    );
    await waitFor(() =>
      expect(
        auditCalls(fetchMock).some(
          (url) => url.includes('orgId=o-north') && url.includes('action=pass.void'),
        ),
      ).toBe(true),
    );
    const opener = screen.getByRole('button', { name: 'Pass voided' });
    await user.click(opener);
    const drawer = await screen.findByRole('dialog');
    expect(router.state.location.search).toMatchObject({ filterOrgId: 'o-north', entry: 1 });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(router.state.location.search).toMatchObject({
      filterOrgId: 'o-north',
      action: 'pass.void',
    });
    expect(router.state.location.search.entry).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'Clear event filters' }));
    await waitFor(() => {
      expect(router.state.location.search.filterOrgId).toBeUndefined();
      expect(router.state.location.search.action).toBeUndefined();
    });
    expect(drawer).not.toBeInTheDocument();
  });

  it('selects, changes and clears global organization filters without memberships', async () => {
    const north = org('o-north', 'North');
    const south = org('o-south', 'South');
    const { router, fetchMock } = await renderApp('/admin/audit?action=pass.void', {
      session: 'admin',
      memberships: [],
      handlers: {
        '/api/v1/orgs': (url) => {
          if (url.searchParams.get('limit') === '200')
            return json({ items: [north, south], nextCursor: null });
          return url.searchParams.get('cursor') === 'next'
            ? json({ items: [south], nextCursor: null })
            : json({ items: [north], nextCursor: 'next' });
        },
        '/api/v1/audit/platform': page([entry(1)]),
      },
    });
    await screen.findByRole('table', { name: 'Audit log' });
    expect(auditCalls(fetchMock)[0]).not.toContain('orgId=');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Filters' }));
    const popover = await screen.findByRole('dialog');
    await user.click(within(popover).getByRole('combobox', { name: 'Organization' }));
    await user.click(await screen.findByRole('option', { name: 'North' }));
    await waitFor(() => expect(router.state.location.search.filterOrgId).toBe('o-north'));
    await waitFor(() =>
      expect(auditCalls(fetchMock).some((url) => url.includes('orgId=o-north'))).toBe(true),
    );
    await user.click(within(popover).getByRole('button', { name: 'Load more organizations' }));
    await user.click(within(popover).getByRole('combobox', { name: 'Organization' }));
    await user.click(await screen.findByRole('option', { name: 'South' }));
    await waitFor(() => expect(router.state.location.search.filterOrgId).toBe('o-south'));
    await waitFor(() =>
      expect(auditCalls(fetchMock).some((url) => url.includes('orgId=o-south'))).toBe(true),
    );
    await user.click(within(popover).getByRole('button', { name: 'Clear organization' }));
    await waitFor(() => {
      expect(router.state.location.search.filterOrgId).toBeUndefined();
      expect(router.state.location.search.action).toBe('pass.void');
    });
    expect(screen.getByText('Organization filter: All organizations')).toBeInTheDocument();
  });

  it('preserves numeric organization and target IDs while changing another filter', async () => {
    const id = '9007199254740993';
    const requests: URL[] = [];
    await renderApp(`/admin/audit?filterOrgId=${id}&targetType=pass&targetId=${id}`, {
      session: 'admin',
      memberships: [],
      handlers: {
        '/api/v1/audit/platform': (url) => {
          requests.push(url);
          return json({ items: [entry(1)], nextCursor: null });
        },
      },
    });
    expect(await screen.findByText(`Organization filter: ${id}`)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /^Action/ }));
    await user.click(await screen.findByRole('option', { name: 'Pass voided' }));
    await waitFor(() =>
      expect(
        requests.some(
          (url) =>
            url.searchParams.get('orgId') === id &&
            url.searchParams.get('targetId') === id &&
            url.searchParams.get('action') === 'pass.void',
        ),
      ).toBe(true),
    );
  });

  it('filters by pass or connection ID without accessing an unrelated tenant', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'wallet-org-filter': 'remembered' }));
    const passes = vi.fn(() => json({ items: [], nextCursor: null }));
    const connections = vi.fn(() => json({ items: [], nextCursor: null }));
    const { router, fetchMock } = await renderApp('/admin/audit?filterOrgId=other', {
      session: 'admin',
      memberships: [membershipFixture('remembered')],
      handlers: {
        '/api/v1/audit/platform': page([entry(1)]),
        '/api/v1/passes': passes,
        '/api/v1/connections': connections,
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Filters (1)' }));
    const popover = await screen.findByRole('dialog');
    await user.click(within(popover).getByRole('button', { name: 'Enter pass ID' }));
    await user.type(within(popover).getByLabelText('Pass ID'), 'pass-outside-membership');
    await user.click(within(popover).getByRole('button', { name: 'Apply pass ID' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        filterOrgId: 'other',
        targetType: 'pass',
        targetId: 'pass-outside-membership',
      }),
    );
    await waitFor(() =>
      expect(
        auditCalls(fetchMock).some(
          (url) =>
            url.includes('targetType=pass') && url.includes('targetId=pass-outside-membership'),
        ),
      ).toBe(true),
    );
    await user.click(within(popover).getByRole('button', { name: 'Enter connection ID' }));
    await user.type(within(popover).getByLabelText('Connection ID'), 'connection-1');
    await user.click(within(popover).getByRole('button', { name: 'Apply connection ID' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        filterOrgId: 'other',
        targetType: 'connection',
        targetId: 'connection-1',
      }),
    );
    await user.click(within(popover).getByRole('button', { name: 'Clear target' }));
    await waitFor(() => expect(router.state.location.search.targetId).toBeUndefined());
    expect(passes).not.toHaveBeenCalled();
    expect(connections).not.toHaveBeenCalled();
  });

  it('shows tenant resource pickers only for the matching selected membership', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'wallet-org-filter': 'o1' }));
    const connections = vi.fn((_url: URL, _init: RequestInit | undefined) =>
      json({ items: [], nextCursor: null }),
    );
    await renderApp('/admin/audit?filterOrgId=o1', {
      session: 'admin',
      memberships: [membershipFixture('o1')],
      handlers: {
        '/api/v1/audit/platform': page([entry(1)]),
        '/api/v1/connections': connections,
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Filters (1)' }));
    const popover = await screen.findByRole('dialog');
    expect(await within(popover).findByRole('combobox', { name: /^Pass/ })).toBeInTheDocument();
    expect(within(popover).getByRole('combobox', { name: /^Connection/ })).toBeInTheDocument();
    await waitFor(() => expect(connections).toHaveBeenCalled());
    expect(connections.mock.calls.every(([url]) => url.searchParams.get('orgId') === 'o1')).toBe(
      true,
    );
  });

  it('offers safe filters and a date range without assuming tenant access', async () => {
    const { router } = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit/platform': page([entry(1)]) },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Filters/ }));
    const popover = await screen.findByRole('dialog');
    expect(within(popover).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(popover).getByRole('combobox', { name: /^User/ })).toBeInTheDocument();
    expect(within(popover).queryByRole('combobox', { name: /^Pass/ })).toBeNull();
    expect(within(popover).getByRole('button', { name: 'Enter pass ID' })).toBeInTheDocument();
    expect(
      within(popover).getByRole('button', { name: 'Enter connection ID' }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Date: any' }));
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'date');
    await user.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(router.state.location.search).toHaveProperty('from'));
  });

  it('can inspect and clear a target-type-only deep link without losing the actor filter', async () => {
    const { router } = await renderApp('/admin/audit?actorId=u1&targetType=pass', {
      session: 'admin',
      handlers: { '/api/v1/audit/platform': page([entry(1)]) },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Filters (2)' }));
    const popover = await screen.findByRole('dialog');
    expect(within(popover).getByText('Pass:')).toBeInTheDocument();
    expect(within(popover).getByText('all')).toBeInTheDocument();
    await user.click(within(popover).getByRole('button', { name: 'Clear target' }));
    await waitFor(() => {
      expect(router.state.location.search.actorId).toBe('u1');
      expect(router.state.location.search.targetType).toBeUndefined();
      expect(router.state.location.search.targetId).toBeUndefined();
    });
  });

  it('filters by action label', async () => {
    const { router } = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit/platform': page([entry(1)]) },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: /^Action/ }));
    await user.click(await screen.findByRole('option', { name: 'Pass voided' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ action: 'pass.void' }),
    );
  });

  it('distinguishes an unknown action prefix from the Any action control', async () => {
    const { router } = await renderApp('/admin/audit?action=any', {
      session: 'admin',
      handlers: { '/api/v1/audit/platform': page([entry(1)]) },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Action: any (prefix)' }));
    await user.click(await screen.findByRole('option', { name: 'Any action' }));
    await waitFor(() => expect(router.state.location.search.action).toBeUndefined());
  });

  it('paginates with the cursor and opens the entry with its code', async () => {
    const { fetchMock } = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: {
        '/api/v1/audit/platform': (url) =>
          url.searchParams.get('cursor') === 'c1'
            ? json({ items: [entry(2)], nextCursor: null })
            : json({ items: [entry(1)], nextCursor: 'c1' }),
      },
    });
    const user = userEvent.setup();
    // The first page must be in before Load more can ask for the next one.
    await screen.findByRole('link', { name: 'Pass 1' });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Pass 2' })).toBeInTheDocument();
    expect(auditCalls(fetchMock).some((u) => u.includes('cursor=c1'))).toBe(true);
    await user.click(screen.getAllByRole('button', { name: 'Pass voided' })[0] as HTMLElement);
    // The drawer is a lazy chunk; a loaded runner needs more than findBy's 1 s default.
    const drawer = await screen.findByRole('dialog', {}, { timeout: 5_000 });
    expect(within(drawer).getByText('pass.void')).toHaveClass('font-mono', 'text-xs');
  });

  it('keeps loaded events and retries when the next cursor page fails', async () => {
    let nextAttempts = 0;
    const { fetchMock } = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: {
        '/api/v1/audit/platform': (url) => {
          if (url.searchParams.get('cursor') !== 'c1')
            return json({ items: [entry(1)], nextCursor: 'c1' });
          nextAttempts += 1;
          return nextAttempts === 1
            ? problem(500, 'temporary', 'Temporary failure')
            : json({ items: [entry(2)], nextCursor: null });
        },
      },
    });
    const user = userEvent.setup();
    await screen.findByRole('link', { name: 'Pass 1' });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByRole('link', { name: 'Pass 1' })).toBeInTheDocument();
    await user.click(retry);
    expect(await screen.findByRole('link', { name: 'Pass 2' })).toBeInTheDocument();
    expect(auditCalls(fetchMock).filter((url) => url.includes('cursor=c1'))).toHaveLength(2);
  });

  it('redacts secrets in the entry detail', async () => {
    await renderApp('/admin/audit', {
      session: 'admin',
      handlers: {
        '/api/v1/audit/platform': page([
          entry(1, {
            detail: {
              before: { name: 'A', apiKey: 'hunter2' },
              after: { name: 'B', apiKey: 'x' },
              mode: 'test',
              version: 'v2',
              reviewedVersion: 'review-3',
              policyProvenance: { source: 'platform', token: 'hidden-context' },
            },
          }),
        ]),
      },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Pass voided' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('region', { name: 'Diff' })).toBeInTheDocument();
    expect(drawer.textContent).not.toContain('hunter');
    expect(drawer.textContent).toContain(REDACTED);
    expect(drawer.textContent).not.toContain('hidden-context');
    expect(within(drawer).getByText('Event ID')).toBeInTheDocument();
    expect(within(drawer).getByText('Recorded mode')).toBeInTheDocument();
    expect(within(drawer).getByText('Recorded version')).toBeInTheDocument();
    expect(within(drawer).getByText('Reviewed version')).toBeInTheDocument();
    expect(
      within(drawer).getByRole('region', { name: 'Other recorded detail JSON' }),
    ).toHaveTextContent('policyProvenance');
  });

  it('does not infer missing organization, mode, version or outcome from the current view', async () => {
    await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit/platform': page([entry(1)]) },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Pass voided' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Not recorded')).toBeInTheDocument();
    expect(within(drawer).queryByText('Recorded mode')).toBeNull();
    expect(within(drawer).queryByText('Recorded version')).toBeNull();
    expect(within(drawer).queryByText('Reviewed version')).toBeNull();
    expect(within(drawer).queryByText('Succeeded')).toBeNull();
  });

  it('shows the log art when empty and the lens when filtered', async () => {
    const empty = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit/platform': page([]) },
    });
    expect(await screen.findByText('No entries')).toBeInTheDocument();
    expect(empty.container.querySelector('[data-art="log"]')).not.toBeNull();
    // jsdom does not map the <search> element to its role.
    expect(empty.container.querySelector('search[aria-label="Filters"]')).not.toBeNull();
    expect(screen.queryByRole('combobox', { name: /^Mode/ })).toBeNull();
    empty.unmount();
    const filtered = await renderApp('/admin/audit?actorId=u9', {
      session: 'admin',
      handlers: { '/api/v1/audit/platform': page([]) },
    });
    expect(await screen.findByText('No entries match')).toBeInTheDocument();
    expect(filtered.container.querySelector('[data-art="lens-overlay"]')).not.toBeNull();
  });

  it('shows an error', async () => {
    const { container } = await renderApp('/admin/audit', {
      session: 'admin',
      handlers: { '/api/v1/audit/platform': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
    expect(container.querySelector('search[aria-label="Filters"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('stacks rows below 768 with action, actor and target', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((media: string) => ({
      matches: media.includes('max-width: 767') || media.includes('prefers-reduced-motion'),
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })) as unknown as typeof matchMedia;
    try {
      await renderApp('/admin/audit', {
        session: 'admin',
        handlers: { '/api/v1/audit/platform': page([entry(1, { orgId: 'o-north' })]) },
      });
      const list = await screen.findByRole('list', { name: 'Audit log' });
      const row = within(list).getAllByRole('listitem')[0] as HTMLElement;
      expect(within(row).getByRole('button', { name: 'Pass voided' })).toBeInTheDocument();
      expect(within(row).getByText('Ada Lovelace')).toBeInTheDocument();
      expect(within(row).getByRole('link', { name: 'Pass 1' })).toBeInTheDocument();
      expect(within(row).getByText('Organization: o-north')).toBeInTheDocument();
      expect(screen.queryByRole('table')).toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });
});
