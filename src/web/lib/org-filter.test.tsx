import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionDetail, passSummary } from '../admin/passes/test-fixtures.ts';
import { membershipsQuery, sessionQuery } from './session.ts';
import { json, membershipFixture, renderApp, sessionFixture } from './test-utils.tsx';

const KEY = 'wallet-org-filter';
const deferred = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
};

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const org = (id: string, name: string) => ({
  id,
  name,
  slug: id,
  status: 'active',
  defaultIdentityId: null,
  branding: {},
  createdAt: 1,
  updatedAt: 1,
  counts: { passes: 0, templates: 0, connections: 0, apiKeys: 0 },
  countsCapped: false,
});
const northwind = membershipFixture('o1', { orgName: 'Northwind Climbing', orgSlug: 'northwind' });
const harbor = membershipFixture('o2', { orgName: 'Harbor', orgSlug: 'harbor' });
const memberships = [northwind, harbor];
const handlers = (seen: string[] = []) => ({
  '/api/v1/orgs': () => json({ items: [org('foreign', 'Directory only')], nextCursor: null }),
  '/api/v1/passes': (url: URL) => {
    seen.push(url.searchParams.get('orgId') ?? 'all');
    return json({ items: [], nextCursor: null });
  },
});

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('organization scope', () => {
  it('prefers an authorized URL to another remembered membership', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: 'o2' }));
    const seen: string[] = [];
    await renderApp('/admin/passes?orgId=o1', {
      session: 'user',
      memberships,
      handlers: handlers(seen),
    });
    const scope = await screen.findByRole('combobox', { name: /^Organization (filter|scope)/ });
    await waitFor(() => expect(scope).toHaveTextContent('Northwind Climbing'));
    await waitFor(() => expect(seen).toContain('o1'));
    expect(seen).not.toContain('o2');
    expect(seen).not.toContain('all');
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe('o1'));
  });

  it.each(['123', 'true', 'null'])(
    'preserves scalar organization ID %s from the URL',
    async (id) => {
      const seen: string[] = [];
      await renderApp(`/admin/passes?orgId=${id}`, {
        session: 'user',
        memberships: [membershipFixture(id)],
        handlers: handlers(seen),
      });
      await screen.findByRole('heading', { name: 'Passes', level: 1 });
      await waitFor(() => expect(seen).toContain(id));
      expect(seen).not.toContain('all');
    },
  );

  it('restores a validated stored membership without losing other URL filters', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: 'o2' }));
    const seen: string[] = [];
    const { router } = await renderApp('/admin/passes?status=active', {
      session: 'user',
      memberships,
      handlers: handlers(seen),
    });
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ status: 'active', orgId: 'o2' }),
    );
    await waitFor(() => expect(seen).toContain('o2'));
    expect(seen.every((id) => id === 'o2')).toBe(true);
  });

  it('requires a choice even with one membership and offers only active memberships', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    const { router } = await renderApp('/admin/passes', {
      session: 'user',
      memberships: [northwind, membershipFixture('revoked', { revokedAt: 1 })],
      handlers: handlers(seen),
    });
    expect(
      await screen.findByRole('heading', { name: 'Choose an organization', level: 1 }),
    ).toBeInTheDocument();
    expect(seen).toEqual([]);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(router.state.location.search).toEqual({});
    await user.click(screen.getByRole('combobox', { name: /^Organization (filter|scope)/ }));
    expect(screen.queryByRole('option', { name: 'revoked' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Directory only' })).toBeNull();
    await user.click(await screen.findByRole('option', { name: 'Northwind Climbing' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ orgId: 'o1' }));
    await waitFor(() => expect(seen).toContain('o1'));
    expect(seen).not.toContain('all');
  });

  it.each([
    ['foreign', '?orgId=foreign'],
    ['empty', '?orgId='],
    ['duplicate', '?orgId=o1&orgId=o1'],
    ['array', '?orgId=%5B%22o1%22%5D'],
    ['object', '?orgId=%7B%22id%22%3A%22o1%22%7D'],
    ['too long', `?orgId=${'x'.repeat(101)}`],
  ])('never falls back to storage for an explicit %s scope', async (_reason, search) => {
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: 'o1' }));
    const seen: string[] = [];
    await renderApp(`/admin/passes${search}`, {
      session: 'user',
      memberships: [northwind],
      handlers: handlers(seen),
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access', level: 1 }),
    ).toBeInTheDocument();
    expect(seen).toEqual([]);
    expect(screen.queryByRole('heading', { name: 'Passes', level: 1 })).toBeNull();
  });

  it.each(['foreign', '', 'x'.repeat(101)])(
    'discards invalid stored selection %s',
    async (stored) => {
      vi.stubGlobal('localStorage', memoryStorage({ [KEY]: stored }));
      const seen: string[] = [];
      const { router } = await renderApp('/admin/passes', {
        session: 'user',
        memberships: [northwind],
        handlers: handlers(seen),
      });
      expect(
        await screen.findByRole('heading', { name: 'Choose an organization', level: 1 }),
      ).toBeInTheDocument();
      await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
      expect(router.state.location.search).not.toHaveProperty('orgId');
      expect(seen).toEqual([]);
    },
  );

  it('keeps platform pages independent from the selected workspace', async () => {
    const user = userEvent.setup();
    const userScopes: (string | null)[] = [];
    const { router } = await renderApp('/admin/users', {
      session: 'admin',
      memberships,
      handlers: {
        ...handlers(),
        '/api/v1/users': (url) => {
          userScopes.push(url.searchParams.get('orgId'));
          return json({ items: [], nextCursor: null });
        },
      },
    });
    await screen.findByRole('heading', { name: 'Platform accounts', level: 1 });
    const scope = await screen.findByRole('combobox', { name: /^Organization (filter|scope)/ });
    await user.click(scope);
    await user.click(await screen.findByRole('option', { name: 'Harbor' }));
    await waitFor(() => expect(scope).toHaveTextContent('Harbor'));
    expect(localStorage.getItem(KEY)).toBe('o2');
    expect(router.state.location.search).not.toHaveProperty('orgId');
    expect(userScopes.every((value) => value === null)).toBe(true);
    const nav = screen.getByRole('navigation', { name: 'Admin' });
    expect(within(nav).getByRole('link', { name: 'Passes' })).toHaveAttribute(
      'href',
      '/admin/passes?orgId=o2',
    );
  });

  it('does not expose a previous principal’s memberships after identity changes', async () => {
    const { queryClient } = await renderApp('/admin/passes?orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      handlers: handlers(),
    });
    await screen.findByRole('heading', { name: 'Passes', level: 1 });
    const session = sessionFixture('admin');
    if (!session.authenticated) throw new Error('Expected an authenticated fixture.');
    act(() => {
      const updatedSession: typeof session = { ...session, user: { ...session.user, id: 'u2' } };
      queryClient.setQueryData(sessionQuery.queryKey, updatedSession);
    });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Passes', level: 1 })).toBeNull(),
    );
    expect(screen.queryByRole('combobox', { name: /^Organization (filter|scope)/ })).toBeNull();
  });

  it('keeps an open picker mounted when grants go stale after 60 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const refresh = deferred.withResolvers<Response>();
      let reads = 0;
      const user = userEvent.setup({ advanceTimers: (ms) => void vi.advanceTimersByTime(ms) });
      await renderApp('/admin/passes?orgId=o1', {
        session: 'user',
        memberships,
        handlers: {
          ...handlers(),
          '/api/v1/orgs/memberships/me': () => {
            reads += 1;
            return reads === 1 ? json({ items: memberships }) : refresh.promise;
          },
        },
      });
      const heading = await screen.findByRole('heading', { name: 'Passes', level: 1 });
      await user.click(await screen.findByRole('combobox', { name: /^Organization filter/ }));
      const option = await screen.findByRole('option', { name: 'Harbor' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      // The refresh is in flight: nothing unmounted, so the picker is still open on its option.
      await waitFor(() => expect(reads).toBe(2));
      expect(screen.queryByText('Loading organizations…')).toBeNull();
      expect(heading).toBeInTheDocument();
      expect(option).toBeInTheDocument();
      await act(async () => refresh.resolve(json({ items: memberships })));
      expect(option).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the page mounted during a membership refresh, then applies the new grants', async () => {
    const reply = deferred.withResolvers<Response>();
    let calls = 0;
    const { queryClient } = await renderApp('/admin/passes?orgId=o1', {
      session: 'admin',
      memberships: [northwind],
      handlers: {
        ...handlers(),
        '/api/v1/orgs/memberships/me': () =>
          ++calls === 1 ? json({ items: [northwind] }) : reply.promise,
      },
    });
    await screen.findByRole('heading', { name: 'Passes', level: 1 });
    act(() => {
      void queryClient.invalidateQueries({ queryKey: membershipsQuery.queryKey, exact: true });
    });
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    expect(screen.getByRole('heading', { name: 'Passes', level: 1 })).toBeInTheDocument();
    await act(async () => {
      reply.resolve(json({ items: [] }));
    });
    expect(
      await screen.findByRole('heading', { name: 'You do not have access', level: 1 }),
    ).toBeInTheDocument();
  });
});

describe('palette query isolation', () => {
  it.each(['organization', 'principal'] as const)(
    'does not carry search results across a %s switch',
    async (change) => {
      const user = userEvent.setup();
      const reply = deferred.withResolvers<Response>();
      let changed = false;
      let principalId = 'u1';
      let requestedNext = false;
      const { router, queryClient } = await renderApp('/admin/passes?orgId=o1', {
        session: 'admin',
        memberships,
        handlers: {
          ...handlers(),
          '/api/v1/session': () => {
            const session = sessionFixture('admin');
            return json(
              session.authenticated
                ? { ...session, user: { ...session.user, id: principalId } }
                : session,
            );
          },
          '/api/v1/orgs/memberships/me': () =>
            json({
              items: memberships.map((membership) => ({ ...membership, userId: principalId })),
            }),
          '/api/v1/passes': (url) => {
            if (!url.searchParams.get('q')) return json({ items: [], nextCursor: null });
            if (changed) {
              requestedNext = true;
              return reply.promise;
            }
            return json({
              items: [passSummary({ orgId: 'o1', title: 'Secret First' })],
              nextCursor: null,
            });
          },
        },
      });
      await screen.findByRole('heading', { name: 'Passes', level: 1 });
      await user.keyboard('{Control>}k{/Control}');
      await user.type(await screen.findByRole('combobox', { name: 'Search' }), 'secret');
      await screen.findByRole('option', { name: /Secret First/ });
      changed = true;
      if (change === 'organization') {
        await act(async () => {
          await router.navigate({ to: '/admin/passes', search: { orgId: 'o2' } });
        });
        await waitFor(() => expect(requestedNext).toBe(true));
        expect(screen.queryByRole('option', { name: /Secret First/ })).toBeNull();
        await act(async () => {
          reply.resolve(
            json({
              items: [passSummary({ orgId: 'o2', title: 'Secret Second' })],
              nextCursor: null,
            }),
          );
        });
        expect(await screen.findByRole('option', { name: /Secret Second/ })).toBeInTheDocument();
      } else {
        principalId = 'u2';
        await act(async () => {
          await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
        });
        await waitFor(() =>
          expect(screen.queryByRole('option', { name: /Secret First/ })).toBeNull(),
        );
      }
    },
  );
});

it('fresh-validates a by-ID resource owner before adopting its organization', async () => {
  vi.stubGlobal('localStorage', memoryStorage({ [KEY]: 'o2' }));
  const reply = deferred.withResolvers<Response>();
  let calls = 0;
  const { router } = await renderApp('/admin/connections/c1', {
    session: 'admin',
    memberships,
    handlers: {
      ...handlers(),
      '/api/v1/connections/c1': () =>
        json(connectionDetail({ orgId: 'o1', name: 'Private connection' })),
      '/api/v1/orgs/memberships/me': () => {
        calls += 1;
        return calls === 1 ? json({ items: memberships }) : reply.promise;
      },
    },
  });
  await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
  expect(router.state.location.search).not.toHaveProperty('orgId');
  expect(screen.queryByText('Private connection')).toBeNull();
  await act(async () => {
    reply.resolve(json({ items: [harbor] }));
  });
  expect(await screen.findByText('Connection not found')).toBeInTheDocument();
  expect(router.state.location.search).not.toHaveProperty('orgId');
  expect(localStorage.getItem(KEY)).not.toBe('o1');
});

describe('organization workspace deep links', () => {
  it.each(['authorized', 'revoked'] as const)(
    'fresh-validates membership before canonicalization when it is %s',
    async (outcome) => {
      vi.stubGlobal('localStorage', memoryStorage({ [KEY]: 'o2' }));
      const reply = deferred.withResolvers<Response>();
      let calls = 0;
      const workspaceRequests: string[] = [];
      const { router } = await renderApp('/admin/orgs/o1?view=workspace', {
        session: 'admin',
        memberships,
        handlers: {
          ...handlers(),
          '/api/v1/orgs/memberships/me': () => {
            calls += 1;
            if (calls === 2) return reply.promise;
            return json({ items: memberships });
          },
          '/api/v1/orgs/o1/workspace': () => {
            workspaceRequests.push('o1');
            return json(org('o1', 'Northwind Climbing'));
          },
          '/api/v1/orgs/o1/memberships': () => json({ items: [] }),
          '/api/v1/orgs/o1/invitations': () => json({ items: [] }),
        },
      });
      await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
      expect(router.state.location.search).not.toHaveProperty('orgId');
      expect(workspaceRequests).toEqual([]);
      await act(async () => {
        reply.resolve(json({ items: outcome === 'authorized' ? memberships : [harbor] }));
      });
      if (outcome === 'authorized') {
        expect(
          await screen.findByRole('heading', { name: 'Northwind Climbing', level: 1 }),
        ).toBeInTheDocument();
        await waitFor(() =>
          expect(router.state.location.search).toMatchObject({ view: 'workspace', orgId: 'o1' }),
        );
        expect(localStorage.getItem(KEY)).toBe('o1');
      } else {
        expect(
          await screen.findByRole('heading', { name: 'Organization not found', level: 1 }),
        ).toBeInTheDocument();
        expect(router.state.location.search).not.toHaveProperty('orgId');
        expect(workspaceRequests).toEqual([]);
      }
    },
  );

  it('masks a conflicting explicit workspace even for a platform admin', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ [KEY]: 'o1' }));
    const { fetchMock } = await renderApp('/admin/orgs/o1?view=workspace&orgId=o2', {
      session: 'admin',
      memberships,
      handlers: {
        ...handlers(),
        '/api/v1/orgs/o1/workspace': () => json(org('o1', 'Northwind Climbing')),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Organization not found', level: 1 }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/api/v1/orgs/o1/workspace')),
    ).toBe(false);
  });
});
