import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bundleKeys, useBundlesOfPass } from './bundle-api.ts';

const mocks = vi.hoisted(() => ({ useOrgScope: vi.fn() }));
vi.mock('../../lib/org-filter.tsx', () => ({ useOrgScope: mocks.useOrgScope }));

afterEach(() => {
  mocks.useOrgScope.mockReset();
  vi.unstubAllGlobals();
});

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const orgId = new URL(String(input), 'http://localhost').searchParams.get('orgId');
    return new Response(
      JSON.stringify({
        items: [
          {
            id: 'b1',
            orgId,
            mode: 'live',
            name: `Bundle ${orgId}`,
            url: 'https://wallet.test/b/tok',
            holderEmail: null,
            passes: [{ id: 'p1', title: 'Pass', status: 'active' }],
            createdAt: 1,
            linkRotatedAt: null,
          },
        ],
        nextCursor: null,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { queryClient, fetchMock, wrapper: Wrapper };
}

const readable = { capabilities: ['passes:read'] };

describe('bundles of a pass', () => {
  it.each([
    ['no selection', { orgId: undefined, isLoading: false, isError: false, membership: undefined }],
    [
      'another selection',
      { orgId: 'org2', isLoading: false, isError: false, membership: readable },
    ],
    [
      'loading membership',
      { orgId: 'org1', isLoading: true, isError: false, membership: readable },
    ],
    ['membership error', { orgId: 'org1', isLoading: false, isError: true, membership: readable }],
    [
      'missing read capability',
      { orgId: 'org1', isLoading: false, isError: false, membership: { capabilities: [] } },
    ],
  ])('does not expose cached bundles or request them with %s', async (_label, scope) => {
    mocks.useOrgScope.mockReturnValue(scope);
    const { queryClient, fetchMock, wrapper } = harness();
    queryClient.setQueryData(bundleKeys.ofPass('p1', 'org1', 'live'), {
      items: [{ name: 'Cached private bundle' }],
      nextCursor: null,
    });

    const { result } = renderHook(() => useBundlesOfPass('p1', 'org1', 'live'), { wrapper });
    expect(result.current.data).toBeUndefined();
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isolates cached results when selection and loaded pass organization change', async () => {
    let scope = { orgId: 'org1', isLoading: false, isError: false, membership: readable };
    mocks.useOrgScope.mockImplementation(() => scope);
    const { queryClient, fetchMock, wrapper } = harness();
    const { result, rerender } = renderHook(
      ({ passOrgId }) => useBundlesOfPass('p1', passOrgId, 'live'),
      { wrapper, initialProps: { passOrgId: 'org1' } },
    );

    await waitFor(() => expect(result.current.data?.items[0]?.name).toBe('Bundle org1'));
    scope = { ...scope, orgId: 'org2' };
    rerender({ passOrgId: 'org1' });
    expect(result.current.data).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ passOrgId: 'org2' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.items[0]?.name).toBe('Bundle org2'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(bundleKeys.ofPass('p1', 'org1', 'live'))).toMatchObject({
      items: [{ name: 'Bundle org1' }],
    });
    expect(queryClient.getQueryData(bundleKeys.ofPass('p1', 'org2', 'live'))).toMatchObject({
      items: [{ name: 'Bundle org2' }],
    });
  });
});
