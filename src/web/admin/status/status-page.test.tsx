import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { dataItems } from './data-items.ts';
import { type Component, componentLink, headline, splitColumns } from './groups.ts';
import { sortBySeverity } from './queries.ts';

const comp = (
  id: string,
  label: string,
  state: string,
  detail: string | null = null,
  kind = 'database',
) => ({ id, kind, label, state, detail, checkedAt: 1_700_000_000_000 });

const status = {
  overall: 'failing',
  build: { id: 'abc', tag: 'v1', timestamp: null },
  components: [
    comp('a', 'Alpha', 'verified'),
    comp('b', 'Beta', 'failing', 'Queue backlog 900'),
    comp('c', 'Cosmos', 'not_configured'),
    comp('d', 'Delta', 'degraded'),
  ],
};
const noRuns = () => json({ items: [] });

const run = (over: Record<string, unknown>) => ({
  instanceId: 'w1',
  kind: 'bulk_reissue',
  orgId: null,
  targetId: null,
  status: 'complete',
  startedAt: 1_700_000_000_000,
  finishedAt: null,
  errorCode: null,
  ...over,
});

describe('status helpers', () => {
  it('orders worst first and keeps label order within a state', () => {
    const sorted = sortBySeverity([
      { state: 'verified', label: 'B' },
      { state: 'verified', label: 'A' },
      { state: 'failing', label: 'Z' },
    ] as const);
    expect(sorted.map((c) => c.label)).toEqual(['Z', 'A', 'B']);
  });

  it('counts leaves only and names their kind', () => {
    const typed = (...c: ReturnType<typeof comp>[]) => c as Component[];
    const connection = typed(
      comp('connections', 'Connections', 'failing', null, 'connection'),
      comp('connection:c1', 'Feed', 'failing', null, 'connection'),
    );
    expect(headline(connection)).toBe('1 connection failing');
    expect(headline([...connection, ...typed(comp('q', 'Q', 'failing', null, 'queue'))])).toBe(
      '2 components failing',
    );
    expect(headline(typed(comp('x', 'X', 'configured')))).toBe('All good');
  });

  it('splits groups into two columns by rows, keeping their order', () => {
    const g = (id: string, n: number) => ({ id, items: Array.from({ length: n }) });
    const [left, right] = splitColumns([
      g('platform', 6),
      g('delivery', 2),
      g('sign-in', 1),
      g('int', 3),
    ]);
    expect(left.map((x) => x.id)).toEqual(['platform']);
    expect(right.map((x) => x.id)).toEqual(['delivery', 'sign-in', 'int']);
  });

  it('links components to the page that owns them', () => {
    expect(componentLink({ id: 'connection:c1', kind: 'connection' })).toBe(
      '/admin/connections/c1',
    );
    expect(componentLink({ id: 'connections', kind: 'connection' })).toBe('/admin/connections');
    expect(componentLink({ id: 'identity:i1', kind: 'identity' })).toBe('/admin/identities/i1');
    expect(componentLink({ id: 'database', kind: 'database' })).toBeUndefined();
  });

  it('maps data keys to labels, humanizes states and hides null values', () => {
    const items = dataItems(
      {
        orgId: 'o1',
        bindingPresent: false,
        lastRunAt: null,
        daysRemaining: 12,
        apnsHealth: 'failing',
        noRecentRun: true,
      },
      (id) => (id === 'o1' ? 'Acme' : undefined),
    );
    expect(items).toEqual([
      { label: 'Organization', value: 'Acme' },
      { label: 'Binding present', value: 'No' },
      { label: 'Days remaining', value: '12' },
      { label: 'APNs health', value: 'Failing' },
    ]);
  });
});

describe('status page', () => {
  it('groups components in cards, sorts by severity and has no a11y violations', async () => {
    const { container } = await renderApp('/admin/status', {
      session: 'admin',
      handlers: { '/api/v1/status': () => json(status), '/api/v1/status/workflows': noRuns },
    });
    const list = await screen.findByRole('list', { name: 'Platform' });
    const labels = within(list)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('p.font-medium')?.textContent);
    expect(labels).toEqual(['Beta', 'Delta', 'Cosmos', 'Alpha']);
    expect(screen.getByText('Queue backlog 900')).toBeInTheDocument();
    expect(screen.getByText('1 database failing')).toBeInTheDocument();
    expect(await screen.findByText('No workflow runs')).toBeInTheDocument();
    expect(container.querySelector('[data-art="runs"]')).not.toBeNull();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('says All good in success tones when nothing fails', async () => {
    await renderApp('/admin/status', {
      session: 'admin',
      handlers: {
        '/api/v1/status': () =>
          json({ ...status, overall: 'verified', components: [comp('a', 'Alpha', 'verified')] }),
        '/api/v1/status/workflows': noRuns,
      },
    });
    const banner = await screen.findByRole('region', { name: 'Overall status' });
    expect(within(banner).getByText('All good')).toBeInTheDocument();
    expect(banner.className).toContain('bg-success-subtle');
    // The buddy's face stands in for the check: decorative, the headline says it.
    expect(banner.firstElementChild).toHaveClass('wl-face');
    expect(banner.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('opens a connection, shows Polaris ID and keeps details behind a disclosure', async () => {
    const withData = {
      ...status,
      components: [
        { ...comp('q', 'Job queue', 'verified', null, 'queue'), data: { backlog: 2, dlq: 1 } },
        comp('oidc', 'Polaris ID', 'verified', null, 'oidc'),
        comp('connections', 'Connections', 'failing', null, 'connection'),
        comp('connection:c1', 'Box office feed', 'failing', null, 'connection'),
      ],
    };
    await renderApp('/admin/status', {
      session: 'admin',
      handlers: { '/api/v1/status': () => json(withData), '/api/v1/status/workflows': noRuns },
    });
    expect(await screen.findByText('1 connection failing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Box office feed' })).toHaveAttribute(
      'href',
      '/admin/connections/c1',
    );
    expect(screen.getByText('Polaris ID')).toBeInTheDocument();
    const platform = screen.getByRole('list', { name: 'Platform' });
    expect(within(platform).getByText('2 queued, 1 dead-lettered')).toBeInTheDocument();
    expect(within(platform).queryByText('Backlog')).toBeNull();
    const toggle = within(platform).getByRole('button', { name: 'Job queue details' });
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(platform).getByText('Backlog')).toBeVisible();
  });

  it('reads No recent run for a deployed cron that has not run in a day', async () => {
    await renderApp('/admin/status', {
      session: 'admin',
      handlers: {
        '/api/v1/status': () =>
          json({
            ...status,
            components: [
              {
                ...comp('cron:daily', 'Cron (daily)', 'degraded', 'No recent run.', 'cron'),
                data: { lastRunAt: null, noRecentRun: true },
              },
            ],
          }),
        '/api/v1/status/workflows': noRuns,
      },
    });
    const platform = await screen.findByRole('list', { name: 'Platform' });
    expect(within(platform).getByText('No recent run')).toBeInTheDocument();
  });

  it('shows an inline pulse when no components report', async () => {
    const { container } = await renderApp('/admin/status', {
      session: 'admin',
      handlers: {
        '/api/v1/status': () => json({ ...status, overall: 'not_configured', components: [] }),
        '/api/v1/status/workflows': noRuns,
      },
    });
    expect(await screen.findByText('No components')).toBeInTheDocument();
    expect(container.querySelector('[data-art="pulse"]')).not.toBeNull();
  });

  it('rechecks past the cache and flashes the check time', async () => {
    const { fetchMock, container } = await renderApp('/admin/status', {
      session: 'admin',
      handlers: { '/api/v1/status': () => json(status), '/api/v1/status/workflows': noRuns },
    });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Recheck' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('fresh=1'))).toBe(true),
    );
    await waitFor(() => expect(container.querySelector('.wl-checked')).not.toBeNull());
    expect(screen.getAllByText(/Checked/)).toHaveLength(1);
  });

  it('shows an error with retry', async () => {
    await renderApp('/admin/status', {
      session: 'admin',
      handlers: {
        '/api/v1/status': () => problem(500, 'boom', 'x'),
        '/api/v1/status/workflows': noRuns,
      },
    });
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('lists runs in the card border, linked, with spinning running pills', async () => {
    const { container } = await renderApp('/admin/status', {
      session: 'admin',
      handlers: {
        '/api/v1/status': () => json(status),
        '/api/v1/status/workflows': () =>
          json({
            items: [
              run({ status: 'errored', errorCode: 'apns_failed', targetId: 't1' }),
              run({ instanceId: 'w2', kind: 'connection_sync', status: 'running', targetId: 'c1' }),
              run({ instanceId: 'u3', kind: 'template_import', status: 'errored', targetId: 'u3' }),
            ],
          }),
      },
    });
    expect(await screen.findByText('apns_failed')).toBeInTheDocument();
    expect(screen.getByText('The run failed. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bulk reissue' })).toHaveAttribute(
      'href',
      '/admin/templates/t1',
    );
    expect(screen.getByRole('link', { name: 'Connection sync' })).toHaveAttribute(
      'href',
      '/admin/connections/c1',
    );
    expect(screen.getByRole('link', { name: 'Template import' })).toHaveAttribute(
      'href',
      '/admin/templates/upload?upload=u3',
    );
    const table = screen.getByRole('table', { name: 'Workflow runs' });
    expect(table.closest('section')?.className).not.toMatch(/\bborder\b/);
    expect(within(table).getByText('Running').querySelector('svg')).toHaveClass('wl-spin');
    const framed: Element[] = [];
    for (let el = table.parentElement; el && el !== container; el = el.parentElement)
      if (el.classList.contains('border') && el.classList.contains('rounded-lg')) framed.push(el);
    expect(framed).toHaveLength(1);
  });
});
