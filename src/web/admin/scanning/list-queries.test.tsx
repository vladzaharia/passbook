import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { AppProviders } from '@/web/lib/providers.tsx';
import { createQueryClient } from '@/web/lib/query-client.ts';
import { json, membershipFixture, sessionFixture, stubFetch } from '@/web/lib/test-utils.tsx';
import { useScannerPages } from './queries.ts';
import { useScanningSessions } from './sessions/api.ts';
import { managedSession } from './sessions/test-fixtures.ts';
import { scannerFixture } from './test-fixtures.ts';

const northwind = membershipFixture('o1', { orgName: 'Northwind' });
const harbor = membershipFixture('o2', { orgName: 'Harbor' });
const list = (items: unknown[]) => ({ items, nextCursor: null });
const cached = (items: unknown[]) => ({ pages: [list(items)], pageParams: [undefined] });

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem('wallet-org-filter');
});

function setup({
  selected = 'o1',
  requested = 'scope',
  memberships = [northwind, harbor],
  scannerEnabled = true,
  seedForeign = false,
  seedOwn = false,
}: {
  selected?: string | undefined;
  requested?: string | undefined;
  memberships?: OrgMembership[];
  scannerEnabled?: boolean;
  seedForeign?: boolean;
  seedOwn?: boolean;
} = {}) {
  localStorage.removeItem('wallet-org-filter');
  const deferred = Promise as PromiseConstructor & {
    withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
  };
  const nextScanner = deferred.withResolvers<Response>();
  const nextSession = deferred.withResolvers<Response>();
  const scannerRequests: (string | null)[] = [];
  const sessionRequests: (string | null)[] = [];
  stubFetch({
    '/api/v1/scan-setups': (url) => {
      const orgId = url.searchParams.get('orgId');
      scannerRequests.push(orgId);
      return orgId === 'o2' ? nextScanner.promise : json(list([scannerFixture()]));
    },
    '/api/v1/scanning-sessions': (url) => {
      const orgId = url.searchParams.get('orgId');
      sessionRequests.push(orgId);
      return orgId === 'o2' ? nextSession.promise : json(list([managedSession]));
    },
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
  queryClient.setQueryData(['session'], sessionFixture('admin'));
  queryClient.setQueryData(['org-memberships', 'me'], { items: memberships });
  queryClient.setQueryData(
    ['admin', 'scanning', 'scanners', 'list', null, false],
    cached([scannerFixture({ name: 'Legacy unscoped scanner' })]),
  );
  queryClient.setQueryData(
    ['admin', 'scanning', 'sessions', 'list', undefined],
    cached([{ ...managedSession, name: 'Legacy unscoped session' }]),
  );
  if (seedForeign) {
    queryClient.setQueryData(
      ['admin', 'scanning', 'scanners', 'list', 'o2', false, true],
      cached([scannerFixture({ orgId: 'o2', name: 'Cached Harbor scanner' })]),
    );
    queryClient.setQueryData(
      ['admin', 'scanning', 'sessions', 'list', 'o2', true],
      cached([{ ...managedSession, orgId: 'o2', name: 'Cached Harbor session' }]),
    );
  }
  if (seedOwn) {
    queryClient.setQueryData(
      ['admin', 'scanning', 'scanners', 'list', 'o1', false, true],
      cached([scannerFixture({ name: 'Cached Northwind scanner' })]),
    );
  }
  function Probe() {
    const scope = useOrgScope();
    const orgId = requested === 'scope' ? scope.orgId : requested;
    const scanners = useScannerPages(orgId, false, scannerEnabled);
    const sessions = useScanningSessions(orgId);
    return (
      <>
        <p data-testid="scanners">
          {scanners.data?.pages
            .flatMap((page) => page.items)
            .map((item) => item.name)
            .join(', ') || 'No data'}
        </p>
        <p data-testid="sessions">
          {sessions.data?.pages
            .flatMap((page) => page.items)
            .map((item) => item.name)
            .join(', ') || 'No data'}
        </p>
        <p data-testid="scanner-error">{scanners.error?.message}</p>
        <p data-testid="session-error">{sessions.error?.message}</p>
        <button type="button" onClick={() => void scanners.refetch()}>
          Refresh scanners
        </button>
        <button type="button" onClick={() => void sessions.refetch()}>
          Refresh sessions
        </button>
      </>
    );
  }
  const root = createRootRoute({ component: Outlet });
  const scanning = createRoute({
    getParentRoute: () => root,
    path: '/admin/scanning',
    validateSearch: (search: Record<string, unknown>) => ({
      orgId: typeof search.orgId === 'string' ? search.orgId : undefined,
    }),
    component: Probe,
  });
  const router = createRouter({
    routeTree: root.addChildren([scanning]),
    history: createMemoryHistory({
      initialEntries: [selected ? `/admin/scanning?orgId=${selected}` : '/admin/scanning'],
    }),
  });
  render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { router, queryClient, scannerRequests, sessionRequests, nextScanner, nextSession };
}

describe('Scanning list organization scope', () => {
  it('does not expose legacy unscoped caches or fetch without a selected organization', async () => {
    const { scannerRequests, sessionRequests } = setup({ selected: '' });
    expect(await screen.findByTestId('scanners')).toHaveTextContent('No data');
    expect(screen.getByTestId('sessions')).toHaveTextContent('No data');
    expect(screen.queryByText('Legacy unscoped scanner')).not.toBeInTheDocument();
    expect(screen.queryByText('Legacy unscoped session')).not.toBeInTheDocument();
    expect(scannerRequests).toEqual([]);
    expect(sessionRequests).toEqual([]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Refresh scanners' }));
    await user.click(screen.getByRole('button', { name: 'Refresh sessions' }));
    await waitFor(() =>
      expect(screen.getByTestId('scanner-error')).toHaveTextContent(
        'Choose an authorized organization.',
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('session-error')).toHaveTextContent(
        'Choose an authorized organization.',
      ),
    );
    expect(scannerRequests).toEqual([]);
    expect(sessionRequests).toEqual([]);
  });

  it('does not fetch or expose a cached other-organization list', async () => {
    const { scannerRequests, sessionRequests } = setup({ requested: 'o2', seedForeign: true });
    expect(await screen.findByTestId('scanners')).toHaveTextContent('No data');
    expect(screen.getByTestId('sessions')).toHaveTextContent('No data');
    expect(screen.queryByText('Cached Harbor scanner')).not.toBeInTheDocument();
    expect(screen.queryByText('Cached Harbor session')).not.toBeInTheDocument();
    expect(scannerRequests).toEqual([]);
    expect(sessionRequests).toEqual([]);
  });

  it('does not load lists without scanning:read on the selected membership', async () => {
    const reader = membershipFixture('o1', { capabilities: ['org:read'] });
    const { scannerRequests, sessionRequests } = setup({ memberships: [reader] });
    expect(await screen.findByTestId('scanners')).toHaveTextContent('No data');
    expect(screen.getByTestId('sessions')).toHaveTextContent('No data');
    expect(scannerRequests).toEqual([]);
    expect(sessionRequests).toEqual([]);
  });

  it('does not load lists for a revoked membership', async () => {
    const revoked = membershipFixture('o1', { revokedAt: 1_700_000_000_001 });
    const { scannerRequests, sessionRequests } = setup({ memberships: [revoked] });
    expect(await screen.findByTestId('scanners')).toHaveTextContent('No data');
    expect(screen.getByTestId('sessions')).toHaveTextContent('No data');
    expect(scannerRequests).toEqual([]);
    expect(sessionRequests).toEqual([]);
  });

  it('does not return a cached scanner list when its caller disables the query', async () => {
    const { scannerRequests } = setup({ scannerEnabled: false, seedOwn: true });
    expect(await screen.findByTestId('scanners')).toHaveTextContent('No data');
    expect(screen.queryByText('Cached Northwind scanner')).not.toBeInTheDocument();
    expect(scannerRequests).toEqual([]);
  });

  it('clears old rows immediately on an organization switch while the new lists load', async () => {
    const { router, scannerRequests, sessionRequests, nextScanner, nextSession } = setup();
    expect(await screen.findByText('Front door')).toBeInTheDocument();
    expect(await screen.findByText('Membership desk')).toBeInTheDocument();
    await act(async () => {
      await router.navigate({ to: '/admin/scanning', search: { orgId: 'o2' } });
    });
    await waitFor(() => {
      expect(scannerRequests).toContain('o2');
      expect(sessionRequests).toContain('o2');
    });
    expect(screen.getByTestId('scanners')).toHaveTextContent('No data');
    expect(screen.getByTestId('sessions')).toHaveTextContent('No data');
    expect(screen.queryByText('Front door')).not.toBeInTheDocument();
    expect(screen.queryByText('Membership desk')).not.toBeInTheDocument();
    await act(async () => {
      nextScanner.resolve(
        json(list([scannerFixture({ id: 's2', orgId: 'o2', name: 'Harbor scanner' })])),
      );
      nextSession.resolve(
        json(list([{ ...managedSession, id: 'session-2', orgId: 'o2', name: 'Harbor desk' }])),
      );
    });
    expect(await screen.findByText('Harbor scanner')).toBeInTheDocument();
    expect(await screen.findByText('Harbor desk')).toBeInTheDocument();
  });

  it('clears both cached lists when scanning read permission is removed', async () => {
    const { queryClient, scannerRequests, sessionRequests } = setup();
    expect(await screen.findByText('Front door')).toBeInTheDocument();
    expect(await screen.findByText('Membership desk')).toBeInTheDocument();
    act(() => {
      queryClient.setQueryData(['org-memberships', 'me'], {
        items: [{ ...northwind, capabilities: ['org:read'] }, harbor],
      });
    });
    await waitFor(() => expect(screen.getByTestId('scanners')).toHaveTextContent('No data'));
    expect(screen.getByTestId('sessions')).toHaveTextContent('No data');
    expect(screen.queryByText('Front door')).not.toBeInTheDocument();
    expect(screen.queryByText('Membership desk')).not.toBeInTheDocument();
    expect(scannerRequests).toContain('o1');
    expect(sessionRequests).toContain('o1');
    expect(scannerRequests.every((orgId) => orgId === 'o1')).toBe(true);
    expect(sessionRequests.every((orgId) => orgId === 'o1')).toBe(true);
  });
});
