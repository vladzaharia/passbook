import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { json, renderApp } from '../../lib/test-utils.tsx';
import { connection, ORG } from '../passes/test-fixtures.ts';

const orgs = () => json({ items: [ORG], nextCursor: null });

describe('connections list', () => {
  it('shows health with one muted line, the source column and a passes link', async () => {
    const seen: URL[] = [];
    const { container } = await renderApp('/admin/connections?health=degraded', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/connectors': () => json({ items: [] }),
        '/api/v1/connections': (url) => {
          seen.push(url);
          return json({
            items: [
              { ...connection({ nextRunAt: Date.now() + 120_000 }), passCount: 3 },
              {
                ...connection({
                  id: 'c2',
                  name: 'Off',
                  enabled: false,
                  health: 'healthy',
                  lastErrorCode: null,
                }),
                passCount: 0,
              },
            ],
            nextCursor: null,
          });
        },
      },
    });
    expect(await screen.findByRole('link', { name: 'MemberSpot sync' })).toHaveAttribute(
      'href',
      '/admin/connections/c1',
    );
    expect(within(screen.getByRole('table')).getByText('Degraded')).toBeInTheDocument();
    expect(screen.getByText(/^2 failures · retries at/)).toHaveClass('text-fg-muted');
    expect(container.querySelector('tbody .text-danger')).toBeNull();
    expect(screen.getAllByText('http-json · Poll')[0]).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '3 passes from MemberSpot sync' })).toHaveAttribute(
      'href',
      '/admin/passes?connectionId=c1',
    );
    // A disabled connection reads Disabled whatever its last health was.
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(seen[0]?.searchParams.get('health')).toBe('degraded');
    expect(screen.getByText('2 connections')).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('pages by cursor, 50 at a time, with Load more', async () => {
    const user = userEvent.setup();
    const seen: URL[] = [];
    await renderApp('/admin/connections', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/connectors': () => json({ items: [] }),
        '/api/v1/connections': (url) => {
          seen.push(url);
          return url.searchParams.get('cursor') === 'c1'
            ? json({
                items: [{ ...connection({ id: 'c2', name: 'Second' }), passCount: 0 }],
                nextCursor: null,
              })
            : json({ items: [{ ...connection(), passCount: 0 }], nextCursor: 'c1' });
        },
      },
    });
    await screen.findByRole('link', { name: 'MemberSpot sync' });
    expect(seen[0]?.searchParams.get('limit')).toBe('50');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Second' })).toBeInTheDocument();
    expect(seen.at(-1)?.searchParams.get('cursor')).toBe('c1');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getByText('2 connections')).toBeInTheDocument();
  });

  it('shows the filtered empty state with Clear filters', async () => {
    const { container } = await renderApp('/admin/connections?health=failing', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/connections': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByText('No connections match')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
    expect(container.querySelector('[data-art="plugs"]')).not.toBeNull();
  });

  it('sends the search term', async () => {
    const seen: URL[] = [];
    await renderApp('/admin/connections?q=member', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/connections': (url) => {
          seen.push(url);
          return json({ items: [], nextCursor: null });
        },
      },
    });
    await screen.findByText('No connections match');
    expect(seen[0]?.searchParams.get('q')).toBe('member');
  });

  it('shows the plugs empty state with a create action', async () => {
    const { container } = await renderApp('/admin/connections', {
      session: 'admin',
      handlers: {
        '/api/v1/orgs': orgs,
        '/api/v1/connections': () => json({ items: [], nextCursor: null }),
      },
    });
    expect(await screen.findByText('No connections')).toBeInTheDocument();
    expect(container.querySelector('[data-art="plugs"]')).not.toBeNull();
    expect(screen.getAllByRole('link', { name: 'New connection' }).length).toBeGreaterThan(0);
  });
});
