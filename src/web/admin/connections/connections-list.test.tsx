import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { setMode } from '../../lib/mode.ts';
import { json, membershipFixture, renderApp } from '../../lib/test-utils.tsx';
import { CONNECTOR, connection, ORG } from '../passes/test-fixtures.ts';

const orgs = () => json({ items: [ORG], nextCursor: null });
const membership = membershipFixture(ORG.id, { orgName: ORG.name, orgSlug: ORG.slug });

describe('connections list', () => {
  it('isolates connection rows and connector catalogs across organization switches', async () => {
    const user = userEvent.setup();
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const oldCatalog = deferred.withResolvers<Response>();
    const catalogScopes: (string | null)[] = [];
    const rowScopes: (string | null)[] = [];
    const { queryClient } = await renderApp('/admin/connections', {
      session: 'admin',
      memberships: [
        membership,
        membershipFixture('org2', { orgName: 'Second', orgSlug: 'second' }),
      ],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/connectors': (url) => {
          const orgId = url.searchParams.get('orgId');
          catalogScopes.push(orgId);
          return orgId === ORG.id
            ? oldCatalog.promise
            : json({ items: [{ ...CONNECTOR, displayName: 'Second catalog' }] });
        },
        '/api/v1/connections': (url) => {
          const orgId = url.searchParams.get('orgId');
          rowScopes.push(orgId);
          return json({
            items: [
              {
                ...connection({
                  id: orgId === 'org2' ? 'c2' : 'c1',
                  orgId,
                  name: orgId === 'org2' ? 'Second connection' : 'First connection',
                }),
                passCount: 0,
              },
            ],
            nextCursor: null,
          });
        },
      },
    });
    expect(await screen.findByRole('link', { name: 'First connection' })).toBeVisible();
    await waitFor(() => expect(catalogScopes).toContain(ORG.id));

    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Second' }));
    expect(await screen.findByRole('link', { name: 'Second connection' })).toBeVisible();
    expect(await screen.findByText('Second catalog · Poll')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'First connection' })).not.toBeInTheDocument();

    await act(async () => {
      oldCatalog.resolve(json({ items: [{ ...CONNECTOR, displayName: 'First catalog' }] }));
      await oldCatalog.promise;
    });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByText('First catalog · Poll')).not.toBeInTheDocument();
    expect(catalogScopes).toContain('org2');
    expect(rowScopes).toContain('org2');
    expect(catalogScopes.every((id) => id === ORG.id || id === 'org2')).toBe(true);
    expect(rowScopes.every((id) => id === ORG.id || id === 'org2')).toBe(true);
  });

  it('retains previous rows while filters change within the same organization', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const reply = deferred.withResolvers<Response>();
    let requested = false;
    const { router } = await renderApp('/admin/connections', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
      handlers: {
        '/api/v1/connectors': () => json({ items: [] }),
        '/api/v1/connections': (url) => {
          if (url.searchParams.get('q') === 'second') {
            requested = true;
            return reply.promise;
          }
          return json({ items: [{ ...connection(), passCount: 0 }], nextCursor: null });
        },
      },
    });
    expect(await screen.findByRole('link', { name: 'MemberSpot sync' })).toBeVisible();
    await act(async () => {
      await router.navigate({ to: '/admin/connections', search: { orgId: ORG.id, q: 'second' } });
    });
    await waitFor(() => expect(requested).toBe(true));
    expect(screen.getByRole('link', { name: 'MemberSpot sync' })).toBeVisible();
    await act(async () => {
      reply.resolve(
        json({
          items: [{ ...connection({ id: 'c2', name: 'Second' }), passCount: 0 }],
          nextCursor: null,
        }),
      );
      await reply.promise;
    });
    expect(await screen.findByRole('link', { name: 'Second' })).toBeVisible();
  });

  it('explains that Test view does not isolate connection operations', async () => {
    const user = userEvent.setup();
    setMode('test');
    try {
      await renderApp('/admin/connections', {
        session: 'admin',
        memberships: [membership],
        selectedOrg: ORG.id,
        handlers: {
          '/api/v1/orgs': orgs,
          '/api/v1/connectors': () => json({ items: [] }),
          '/api/v1/connections': () => json({ items: [], nextCursor: null }),
        },
      });
      expect(
        await screen.findByText(/Connections are shared between Live and Test/),
      ).toHaveTextContent('Changes, tests and syncs can affect live data');
      expect(screen.queryByText('Know what is connected')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Turn off Test mode' }));
      expect(screen.queryByText(/Connections are shared between Live and Test/)).toBeNull();
    } finally {
      setMode('live');
    }
  });

  it('shows health with one muted line, the source column and a passes link', async () => {
    const seen: URL[] = [];
    const { container } = await renderApp('/admin/connections?health=degraded', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
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
      '/admin/connections/c1?orgId=org1',
    );
    expect(within(screen.getByRole('table')).getByText('Degraded')).toBeInTheDocument();
    expect(screen.getByText(/^2 failures · retries at/)).toHaveClass('text-fg-muted');
    expect(container.querySelector('tbody .text-danger')).toBeNull();
    expect(screen.getAllByText('http-json · Poll')[0]).toBeInTheDocument();
    const passesLink = screen.getByRole('link', { name: '3 passes from MemberSpot sync' });
    const passesUrl = new URL(passesLink.getAttribute('href') ?? '', 'http://localhost');
    expect(passesUrl.pathname).toBe('/admin/passes');
    expect(Object.fromEntries(passesUrl.searchParams)).toEqual({
      connectionId: 'c1',
      orgId: ORG.id,
    });
    // A disabled connection reads Disabled whatever its last health was.
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(seen[0]?.searchParams.get('health')).toBe('degraded');
    expect(seen[0]?.searchParams.get('orgId')).toBe(ORG.id);
    expect(screen.getByText(`2 connections in ${ORG.name}`)).toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('pages by cursor, 50 at a time, with Load more', async () => {
    const user = userEvent.setup();
    const seen: URL[] = [];
    await renderApp('/admin/connections', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
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
    expect(seen[0]?.searchParams.get('orgId')).toBe(ORG.id);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Second' })).toBeInTheDocument();
    expect(seen.at(-1)?.searchParams.get('cursor')).toBe('c1');
    expect(seen.at(-1)?.searchParams.get('orgId')).toBe(ORG.id);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(screen.getByText(`2 connections in ${ORG.name}`)).toBeInTheDocument();
  });

  it('shows the filtered empty state with Clear filters', async () => {
    const { container } = await renderApp('/admin/connections?health=failing', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
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
      memberships: [membership],
      selectedOrg: ORG.id,
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
    expect(seen[0]?.searchParams.get('orgId')).toBe(ORG.id);
  });

  it.each(['empty', 'populated'])(
    'keeps the %s connection list read-only without integration management',
    async (state) => {
      await renderApp('/admin/connections', {
        session: 'admin',
        memberships: [
          membershipFixture(ORG.id, {
            orgName: ORG.name,
            orgSlug: ORG.slug,
            capabilities: ['integrations:read'],
          }),
        ],
        selectedOrg: ORG.id,
        handlers: {
          '/api/v1/connectors': () => json({ items: [] }),
          '/api/v1/connections': () =>
            json({
              items: state === 'empty' ? [] : [{ ...connection(), passCount: 2 }],
              nextCursor: null,
            }),
        },
      });

      if (state === 'empty') {
        expect(await screen.findByText('No connections')).toBeVisible();
      } else {
        expect(await screen.findByRole('link', { name: 'MemberSpot sync' })).toBeVisible();
      }
      expect(screen.queryByRole('link', { name: 'New connection' })).not.toBeInTheDocument();
    },
  );

  it('shows the plugs empty state with a create action', async () => {
    const { container } = await renderApp('/admin/connections', {
      session: 'admin',
      memberships: [membership],
      selectedOrg: ORG.id,
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
