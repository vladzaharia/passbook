import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';
import { managedSession } from './sessions/test-fixtures.ts';
import { NOW, scannerFixture } from './test-fixtures.ts';

const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const harbor = membershipFixture('o2', { orgName: 'Harbor', orgSlug: 'harbor' });
const page = () => json({ items: [], nextCursor: null });

const cases = [
  {
    kind: 'event',
    path: '/admin/scanning/events/e1',
    endpoint: '/api/v1/scan-events/e1',
    key: ['admin', 'scanning', 'events', 'e1'],
    name: 'Cached private event',
    data: {
      id: 'e1',
      orgId: 'o2',
      mode: 'live',
      name: 'Cached private event',
      templateIds: [],
      match: null,
      opensAt: NOW,
      closesAt: NOW + 3_600_000,
      timeZone: 'UTC',
      capacity: null,
      reentry: false,
      note: null,
      status: 'upcoming',
      arrived: 0,
      expected: 0,
      scanners: 0,
    },
  },
  {
    kind: 'scanner',
    path: '/admin/scanning/scanners/s1',
    endpoint: '/api/v1/scan-setups/s1',
    key: ['admin', 'scanning', 'scanners', 'detail', 's1'],
    name: 'Cached private scanner',
    data: scannerFixture({
      orgId: 'o2',
      name: 'Cached private scanner',
      sessionId: 'private-session',
    }),
  },
  {
    kind: 'session',
    path: '/admin/scanning/sessions/session-1',
    endpoint: '/api/v1/scanning-sessions/session-1',
    key: ['admin', 'scanning', 'sessions', 'detail', 'session-1'],
    name: 'Cached private session',
    data: { ...managedSession, orgId: 'o2', orgName: 'Harbor', name: 'Cached private session' },
  },
] as const;

describe('Scanning detail links', () => {
  it.each(cases)(
    'revalidates cached $kind ownership before selecting an organization',
    async (item) => {
      const previous = localStorage.getItem('wallet-org-filter');
      localStorage.setItem('wallet-org-filter', 'o1');
      try {
        const deferred = Promise as PromiseConstructor & {
          withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
        };
        const { promise: response, resolve: answer } = deferred.withResolvers<Response>();
        let requests = 0;
        const dependent: string[] = [];
        const { router, queryClient } = await renderApp('/admin/scanning?orgId=o1', {
          session: 'admin',
          memberships: [northwind, harbor],
          selectedOrg: 'o1',
          handlers: {
            '/api/v1/scanning-sessions': page,
            '/api/v1/scan-setups': page,
            '/api/v1/templates': () => {
              dependent.push('templates');
              return page();
            },
            '/api/v1/scanners': () => {
              dependent.push('scanners');
              return page();
            },
            '/api/v1/scan-events': () => {
              dependent.push('events');
              return page();
            },
            '/api/v1/scanning-sessions/private-session': () => {
              dependent.push('redirected');
              return page();
            },
            [item.endpoint]: () => {
              requests += 1;
              return response;
            },
          },
        });
        await screen.findByRole('heading', { name: 'Scanning', level: 1 });
        const before = dependent.length;
        queryClient.setQueryData(item.key, item.data);
        act(() => {
          router.history.push(item.path);
        });
        await waitFor(() => expect(requests).toBeGreaterThan(0));
        expect(router.state.location.search.orgId).toBeUndefined();
        expect(screen.queryByText(item.name)).not.toBeInTheDocument();
        expect(dependent).toHaveLength(before);
        await act(async () => {
          answer(problem(403, 'forbidden', 'Forbidden.'));
        });
        expect(
          await screen.findByRole('heading', { name: 'You do not have access' }),
        ).toBeInTheDocument();
        expect(router.state.location.search.orgId).toBeUndefined();
        expect(screen.queryByText(item.name)).not.toBeInTheDocument();
        expect(dependent).toHaveLength(before);
      } finally {
        if (previous === null) localStorage.removeItem('wallet-org-filter');
        else localStorage.setItem('wallet-org-filter', previous);
      }
    },
  );

  it.each(cases)(
    'revalidates cached $kind ownership even with an explicit organization',
    async (item) => {
      let answer!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => {
        answer = resolve;
      });
      let requests = 0;
      const dependent: string[] = [];
      const { router, queryClient } = await renderApp('/admin/scanning?orgId=o1', {
        session: 'admin',
        memberships: [northwind, harbor],
        selectedOrg: 'o1',
        handlers: {
          '/api/v1/scanning-sessions': page,
          '/api/v1/scan-setups': page,
          '/api/v1/templates': () => {
            dependent.push('templates');
            return page();
          },
          '/api/v1/scanners': () => {
            dependent.push('scanners');
            return page();
          },
          '/api/v1/scan-events': () => {
            dependent.push('events');
            return page();
          },
          '/api/v1/scanning-sessions/private-session': () => {
            dependent.push('redirected');
            return page();
          },
          [item.endpoint]: () => {
            requests += 1;
            return response;
          },
        },
      });
      await screen.findByRole('heading', { name: 'Scanning', level: 1 });
      const before = dependent.length;
      queryClient.setQueryData(item.key, { ...item.data, orgId: 'o1' });
      act(() => router.history.push(`${item.path}?orgId=o1`));
      await waitFor(() => expect(requests).toBeGreaterThan(0));
      expect(screen.queryByText(item.name)).not.toBeInTheDocument();
      expect(dependent).toHaveLength(before);
      await act(async () => {
        answer(json(item.data));
      });
      expect(
        await screen.findByText(item.kind === 'event' ? 'Event not found' : 'Scanner not found'),
      ).toBeInTheDocument();
      expect(screen.queryByText(item.name)).not.toBeInTheDocument();
      expect(dependent).toHaveLength(before);
    },
  );
});
