import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { broadcast } from './test-fixtures.ts';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
});

const modeOf = (calls: unknown[][], path: string) => {
  const call = calls.find(([u]) => String(u).startsWith(path));
  return ((call?.[1] as RequestInit | undefined)?.headers as Record<string, string>)?.[
    'x-passbook-mode'
  ];
};
const orgAccess = { memberships: [membershipFixture('o1')], selectedOrg: 'o1' };

describe('Message capabilities', () => {
  it('does not request the list until an authorized organization is selected', async () => {
    const scopes: (string | null)[] = [];
    await renderApp('/admin/messages', {
      session: 'admin',
      memberships: [membershipFixture('o1', { orgName: 'Northwind' })],
      handlers: {
        '/api/v1/broadcasts': (url) => {
          scopes.push(url.searchParams.get('orgId'));
          return json({ items: [], nextCursor: null });
        },
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose an organization' }),
    ).toBeInTheDocument();
    expect(scopes).toEqual([]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: /^Organization filter/ }));
    await user.click(await screen.findByRole('option', { name: 'Northwind' }));
    await waitFor(() => expect(scopes).toContain('o1'));
    expect(scopes).not.toContain(null);
  });

  it('does not treat a platform admin’s explicit organization as a membership grant', async () => {
    const scopes: (string | null)[] = [];
    await renderApp('/admin/messages?orgId=o1', {
      session: 'admin',
      memberships: [membershipFixture('o2')],
      handlers: {
        '/api/v1/broadcasts': (url) => {
          scopes.push(url.searchParams.get('orgId'));
          return json({ items: [broadcast({ name: 'Private message' })], nextCursor: null });
        },
      },
    });
    expect(
      await screen.findByRole('heading', { name: /Choose an organization|You do not have access/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Private message')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New message' })).not.toBeInTheDocument();
    expect(scopes).toEqual([]);
  });

  it('hides the old list while the newly selected organization loads', async () => {
    const deferred = Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
    };
    const other = deferred.withResolvers<Response>();
    const scopes: (string | null)[] = [];
    const { router } = await renderApp('/admin/messages', {
      session: 'admin',
      memberships: [membershipFixture('o1'), membershipFixture('o2')],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/broadcasts': (url) => {
          const orgId = url.searchParams.get('orgId');
          scopes.push(orgId);
          return orgId === 'o2'
            ? other.promise
            : json({
                items: [broadcast({ name: 'First organization message' })],
                nextCursor: null,
              });
        },
      },
    });
    expect(await screen.findByText('First organization message')).toBeInTheDocument();
    await act(async () => {
      await router.navigate({ to: '/admin/messages', search: { orgId: 'o2' } });
    });
    await waitFor(() => expect(scopes).toContain('o2'));
    expect(screen.queryByText('First organization message')).not.toBeInTheDocument();
    expect(scopes).not.toContain(null);
    await act(async () => {
      other.resolve(
        json({
          items: [broadcast({ id: 'b2', orgId: 'o2', name: 'Second organization message' })],
          nextCursor: null,
        }),
      );
      await other.promise;
    });
    expect(await screen.findByText('Second organization message')).toBeInTheDocument();
  });

  it.each([
    { session: 'admin', empty: false },
    { session: 'admin', empty: true },
    { session: 'user', empty: false },
    { session: 'user', empty: true },
  ] as const)(
    'keeps the list readable for $session without creation (empty: $empty)',
    async ({ session, empty }) => {
      await renderApp('/admin/messages', {
        session,
        memberships: [
          membershipFixture('o1', { capabilities: ['messages:read', 'passes:operate'] }),
        ],
        selectedOrg: 'o1',
        handlers: {
          '/api/v1/broadcasts': () => json({ items: empty ? [] : [broadcast()], nextCursor: null }),
        },
      });
      expect(
        await screen.findByText(empty ? 'No messages' : 'Doors open late'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'New message' })).not.toBeInTheDocument();
    },
  );

  it.each(['admin', 'user'] as const)(
    'offers creation to %s when the membership can manage messages',
    async (session) => {
      await renderApp('/admin/messages', {
        session,
        memberships: [
          membershipFixture('o1', { capabilities: ['messages:read', 'messages:manage'] }),
        ],
        selectedOrg: 'o1',
        handlers: {
          '/api/v1/broadcasts': () => json({ items: [broadcast()], nextCursor: null }),
        },
      });
      expect(await screen.findByText('Doors open late')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'New message' }).getAttribute('href')).toMatch(
        /^\/admin\/messages\/new(?:\?|$)/,
      );
    },
  );
});

describe('Messages in Test mode', () => {
  it('sends the Test header and leaves the per-row pill off when every message is a test', async () => {
    setMode('test');
    const { container, fetchMock } = await renderApp('/admin/messages', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/broadcasts': () =>
          json({ items: [broadcast({ mode: 'test' })], nextCursor: null }),
      },
    });
    expect(await screen.findByText('Doors open late')).toBeInTheDocument();
    expect(modeOf(fetchMock.mock.calls, '/api/v1/broadcasts')).toBe('test');
    const listCall = fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/v1/broadcasts'));
    expect(new URL(String(listCall?.[0]), 'http://localhost').searchParams.get('orgId')).toBe('o1');
    expect(screen.queryByRole('button', { name: /^Test\. Test mode/ })).not.toBeInTheDocument();
    expect((await axe(container)).violations).toEqual([]);
  });

  it('marks a test message among live ones', async () => {
    await renderApp('/admin/messages', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/broadcasts': () =>
          json({ items: [broadcast({ mode: 'test' }), broadcast({ id: 'b2' })], nextCursor: null }),
      },
    });
    expect(await screen.findAllByText('Doors open late')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^Test\. Test mode/ })).toHaveLength(1);
  });

  it('tells a scheduled message when it goes out under its name', async () => {
    await renderApp('/admin/messages', {
      session: 'admin',
      ...orgAccess,
      handlers: {
        '/api/v1/broadcasts': () =>
          json({
            items: [broadcast({ state: 'scheduled', at: Date.now() + 3_600_000, startedAt: null })],
            nextCursor: null,
          }),
      },
    });
    expect((await screen.findAllByText(/^Starts /)).length).toBeGreaterThan(0);
  });

  it('sends no header live, and a live message has no Test pill', async () => {
    const { fetchMock } = await renderApp('/admin/messages/b1', {
      session: 'admin',
      ...orgAccess,
      handlers: { '/api/v1/broadcasts/b1': () => json(broadcast()) },
    });
    expect(await screen.findByRole('heading', { name: 'Doors open late' })).toBeInTheDocument();
    expect(modeOf(fetchMock.mock.calls, '/api/v1/broadcasts/b1')).toBeUndefined();
    expect(screen.queryByText('Test')).not.toBeInTheDocument();
  });

  it('badges a test message opened in live mode', async () => {
    await renderApp('/admin/messages/b1', {
      session: 'admin',
      ...orgAccess,
      handlers: { '/api/v1/broadcasts/b1': () => json(broadcast({ mode: 'test' })) },
    });
    expect(await screen.findByRole('heading', { name: 'Doors open late' })).toBeInTheDocument();
    expect(screen.getByText('Test')).toBeInTheDocument();
  });
});
