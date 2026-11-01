import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';

const series = (vals: number[]) =>
  vals.map((v, i) => ({ t: 1_700_000_000_000 + i * 86_400_000, v }));
const none = series([]);

const setup = {
  orgs: 2,
  assignedTemplates: 3,
  passes: 1200,
  passEmailsSent: 9,
  latestPassId: 'p9',
};

const overview = (over: Record<string, unknown> = {}) => ({
  source: 'analytics_engine',
  range: '7d',
  bucketMs: 86_400_000,
  unavailable: [],
  totals: {
    passes: 1200,
    activePasses: 1100,
    voidedPasses: 100,
    holders: 900,
    devices: 800,
    issued: 40,
    updated: 12,
    downloads: 33,
    pushFailures: 2,
    registrations: 0,
    refreshes: 0,
    pushes: 0,
    emails: 0,
    emailFailures: 0,
    syncRuns: 0,
    signIns: 0,
  },
  series: {
    issued: series([1, 3, 2]),
    updated: series([0, 0, 0]),
    downloads: none,
    registrations: none,
    refreshes: none,
    pushes: series([5, 1]),
    pushFailures: none,
    emails: none,
    emailFailures: none,
    syncRuns: none,
    signIns: none,
  },
  setup,
  recent: [],
  ...over,
});

const component = (id: string, kind: string, label: string, state: string) => ({
  id,
  kind,
  label,
  state,
  detail: null,
  checkedAt: 1,
});
const status = {
  overall: 'failing',
  build: { id: null, tag: null, timestamp: null },
  components: [
    component('connections', 'connection', 'Connections', 'failing'),
    component('connection:c1', 'connection', 'Box office feed', 'failing'),
    component('d', 'database', 'D1', 'verified'),
  ],
};

const entry = (id: number, action: string, target: Record<string, unknown> = {}) => ({
  id,
  at: Date.now() - id * 60_000,
  orgId: null,
  actorType: 'user',
  actorId: 'u1',
  actorLabel: 'Ada',
  action,
  targetType: null,
  targetId: null,
  targetLabel: null,
  requestId: null,
  detail: null,
  ...target,
});
const audit = {
  items: [
    entry(1, 'pass.void', { targetType: 'pass', targetId: 'p1', targetLabel: 'Clara Rossi' }),
    entry(2, 'settings.update'),
  ],
  nextCursor: null,
};

const ok = {
  '/api/v1/metrics/overview': () => json(overview()),
  '/api/v1/status': () => json(status),
  '/api/v1/audit': () => json(audit),
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('overview page', () => {
  it('renders linked totals, charts, health and activity without a11y violations', async () => {
    const { container } = await renderApp('/admin', { session: 'admin', handlers: ok });
    const totals = await screen.findByRole('list', { name: 'Totals' });
    expect(within(totals).getByText('1,200')).toBeInTheDocument();
    expect(within(totals).getByRole('link', { name: /Passes/ })).toHaveAttribute(
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

  it('asks for the range and hides sign-ins from activity', async () => {
    const { fetchMock } = await renderApp('/admin?range=30d', { session: 'admin', handlers: ok });
    await screen.findByRole('list', { name: 'Totals' });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.find((u) => u.includes('/metrics/'))).toContain('range=30d');
    await waitFor(() => expect(urls.find((u) => u.includes('/audit'))).toBeDefined());
    const call = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/audit'));
    expect(call).toContain('excludeAction=auth.');
    expect(call).toContain('limit=6');
  });

  it('labels D1 numbers approximate and toggles the data tables', async () => {
    await renderApp('/admin', {
      session: 'admin',
      handlers: {
        ...ok,
        '/api/v1/metrics/overview': () =>
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
      handlers: { ...ok, '/api/v1/metrics/overview': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Server error. Try again.')).toBeInTheDocument();
    expect(await screen.findByText('Box office feed')).toBeInTheDocument();
  });

  it('says All good and shows the activity art when there is nothing', async () => {
    const { container } = await renderApp('/admin', {
      session: 'admin',
      handlers: {
        ...ok,
        '/api/v1/status': () => json({ ...status, overall: 'verified', components: [] }),
        '/api/v1/audit': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByText('All good')).toBeInTheDocument();
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
    expect(container.querySelector('[data-art="activity"]')).not.toBeNull();
  });
});

describe('get started', () => {
  const empty = { orgs: 0, assignedTemplates: 0, passes: 0, passEmailsSent: 0, latestPassId: null };
  const zero = (s: Record<string, unknown>) =>
    overview({
      setup: { ...empty, ...s },
      totals: { ...overview().totals, passes: 0, activePasses: 0, holders: 0, pushFailures: 0 },
    });

  it('replaces the charts with four steps that check themselves', async () => {
    const { container } = await renderApp('/admin', {
      session: 'admin',
      handlers: { ...ok, '/api/v1/metrics/overview': () => json(zero({ orgs: 1 })) },
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
    expect(container.querySelector('[data-art="building"]')).not.toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('sends step four to the newest pass holder tab, and goes once an email is sent', async () => {
    let sent = 0;
    const { queryClient } = await renderApp('/admin', {
      session: 'admin',
      handlers: {
        ...ok,
        '/api/v1/metrics/overview': () =>
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
    const handlers = { ...ok, '/api/v1/metrics/overview': () => json(zero({})) };
    const first = await renderApp('/admin', { session: 'admin', handlers });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
    first.unmount();
    await renderApp('/admin', { session: 'admin', handlers });
    expect(await screen.findByRole('img', { name: /Issued/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull();
  });
});
