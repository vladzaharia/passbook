import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { sortBySeverity } from './queries.ts';

const comp = (id: string, label: string, state: string, detail: string | null = null) => ({
  id,
  kind: 'database',
  label,
  state,
  detail,
  checkedAt: 1_700_000_000_000,
});

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

describe('sortBySeverity', () => {
  it('orders worst first and keeps label order within a state', () => {
    const sorted = sortBySeverity([
      { state: 'verified', label: 'B' },
      { state: 'verified', label: 'A' },
      { state: 'failing', label: 'Z' },
    ] as const);
    expect(sorted.map((c) => c.label)).toEqual(['Z', 'A', 'B']);
  });
});

describe('status page', () => {
  it('lists components by severity and has no a11y violations', async () => {
    const { container } = await renderApp('/admin/status', {
      session: 'admin',
      handlers: {
        '/api/v1/status': () => json(status),
        '/api/v1/status/workflows': () => json({ items: [] }),
      },
    });
    const list = await screen.findByRole('list', { name: 'Components' });
    const labels = within(list)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('p')?.textContent);
    expect(labels).toEqual(['Beta', 'Delta', 'Cosmos', 'Alpha']);
    expect(screen.getByText('Queue backlog 900')).toBeInTheDocument();
    expect(await screen.findByText('No workflow runs')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('shows an error with retry', async () => {
    await renderApp('/admin/status', {
      session: 'admin',
      handlers: {
        '/api/v1/status': () => problem(500, 'boom', 'x'),
        '/api/v1/status/workflows': () => json({ items: [] }),
      },
    });
    expect(await screen.findByText('Server error. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows workflow runs', async () => {
    await renderApp('/admin/status', {
      session: 'admin',
      handlers: {
        '/api/v1/status': () => json(status),
        '/api/v1/status/workflows': () =>
          json({
            items: [
              {
                instanceId: 'w1',
                kind: 'bulk_reissue',
                orgId: null,
                targetId: null,
                status: 'errored',
                startedAt: 1_700_000_000_000,
                finishedAt: null,
                errorCode: 'apns_failed',
              },
            ],
          }),
      },
    });
    expect(await screen.findByText('apns_failed')).toBeInTheDocument();
    expect(screen.getByText('bulk_reissue')).toBeInTheDocument();
  });
});
