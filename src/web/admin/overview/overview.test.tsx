import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { chartGeometry, niceMax } from './chart.tsx';
import { daysUntil, formatRelative } from './format.ts';

const series = (vals: number[]) =>
  vals.map((v, i) => ({ t: 1_700_000_000_000 + i * 86_400_000, v }));

const overview = (over: Record<string, unknown> = {}) => ({
  source: 'analytics_engine',
  range: '7d',
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
  },
  series: {
    issued: series([1, 3, 2]),
    updated: series([0, 0, 0]),
    downloads: series([]),
    pushes: series([5, 1]),
  },
  recent: [],
  ...over,
});

const status = {
  overall: 'degraded',
  build: { id: null, tag: null, timestamp: null },
  components: [
    {
      id: 'q',
      kind: 'queue',
      label: 'Push queue',
      state: 'degraded',
      detail: null,
      checkedAt: 1,
    },
    { id: 'd', kind: 'database', label: 'D1', state: 'verified', detail: null, checkedAt: 1 },
  ],
};

const audit = {
  items: [
    {
      id: 1,
      at: 1_700_000_000_000,
      orgId: null,
      actorType: 'user',
      actorId: 'u1',
      action: 'pass.voided',
      targetType: 'pass',
      targetId: 'p1',
      requestId: null,
      detail: null,
    },
  ],
  nextCursor: null,
};

const ok = {
  '/api/v1/metrics/overview': () => json(overview()),
  '/api/v1/status': () => json(status),
  '/api/v1/audit': () => json(audit),
};

describe('chart helpers', () => {
  it('rounds the axis maximum to 1, 2 or 5 steps', () => {
    expect([0, 1, 3, 7, 12, 480, 1001].map(niceMax)).toEqual([1, 1, 5, 10, 20, 500, 2000]);
  });
  it('maps points into the plot area', () => {
    const g = chartGeometry(series([0, 10]));
    expect(g.max).toBe(10);
    expect(g.xs).toHaveLength(2);
    expect(g.ys[0]).toBeGreaterThan(g.ys[1] ?? 0);
    expect(g.line.startsWith('M')).toBe(true);
    expect(g.area.endsWith('Z')).toBe(true);
  });
  it('handles empty and single-point series', () => {
    expect(chartGeometry([]).line).toBe('');
    const one = chartGeometry([{ t: 5, v: 3 }]);
    expect(one.xs).toHaveLength(1);
    expect(Number.isFinite(one.xs[0])).toBe(true);
  });
});

describe('format helpers', () => {
  it('formats relative times and day counts', () => {
    expect(formatRelative(0, 2 * 86_400_000)).toMatch(/2 days ago/);
    expect(daysUntil(3 * 86_400_000 + 5, 0)).toBe(3);
    expect(daysUntil(0, 86_400_000 * 2 - 1)).toBe(-2);
  });
});

describe('overview page', () => {
  it('renders totals, charts, health and activity without a11y violations', async () => {
    const { container } = await renderApp('/admin', { session: 'admin', handlers: ok });
    const totals = await screen.findByRole('list', { name: 'Totals' });
    expect(within(totals).getByText('1,200')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Issued: 6 total, peak 3/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Updated: 0 total/ })).toBeInTheDocument();
    expect(screen.getByText('Downloads').closest('figure')).toHaveTextContent('No data');
    expect(await screen.findByText('Push queue')).toBeInTheDocument();
    expect(await screen.findByText('pass.voided')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('requests the selected range from the URL', async () => {
    const { fetchMock } = await renderApp('/admin?range=30d', { session: 'admin', handlers: ok });
    await screen.findByRole('list', { name: 'Totals' });
    const call = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/metrics/'));
    expect(call).toContain('range=30d');
  });

  it('marks D1-sourced numbers as approximate', async () => {
    await renderApp('/admin', {
      session: 'admin',
      handlers: { ...ok, '/api/v1/metrics/overview': () => json(overview({ source: 'd1' })) },
    });
    expect(await screen.findByText('Approximate')).toBeInTheDocument();
  });

  it('keeps other panels when metrics fail', async () => {
    await renderApp('/admin', {
      session: 'admin',
      handlers: { ...ok, '/api/v1/metrics/overview': () => problem(500, 'x', 'x') },
    });
    expect(await screen.findByText('Server error. Try again.')).toBeInTheDocument();
    expect(await screen.findByText('Push queue')).toBeInTheDocument();
  });

  it('reports a healthy platform when nothing is degraded', async () => {
    await renderApp('/admin', {
      session: 'admin',
      handlers: {
        ...ok,
        '/api/v1/status': () => json({ ...status, overall: 'verified', components: [] }),
        '/api/v1/audit': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByText('No failing or degraded components.')).toBeInTheDocument();
    expect(await screen.findByText('No activity yet.')).toBeInTheDocument();
  });
});
