import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passKeys, usePassAudit } from './api.ts';

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
            id: 1,
            at: 1,
            orgId,
            actorType: 'system',
            actorId: null,
            actorLabel: `Actor ${orgId}`,
            action: 'pass.update',
            targetType: 'pass',
            targetId: 'p1',
            requestId: null,
            detail: null,
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

const readable = { capabilities: ['audit:read'] };

describe('pass audit scope', () => {
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
      'passes:read without audit:read',
      {
        orgId: 'org1',
        isLoading: false,
        isError: false,
        membership: { capabilities: ['passes:read'] },
      },
    ],
    [
      'missing read capability',
      { orgId: 'org1', isLoading: false, isError: false, membership: { capabilities: [] } },
    ],
  ])('does not expose cached activity or request it with %s', async (_label, scope) => {
    mocks.useOrgScope.mockReturnValue(scope);
    const { queryClient, fetchMock, wrapper } = harness();
    queryClient.setQueryData(passKeys.audit('p1', 'org1'), {
      items: [{ actorLabel: 'Cached private actor' }],
      nextCursor: null,
    });
    const { result } = renderHook(() => usePassAudit('p1', 'org1', true), { wrapper });
    expect(result.current.data).toBeUndefined();
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waits until the activity tab is active', () => {
    mocks.useOrgScope.mockReturnValue({
      orgId: 'org1',
      isLoading: false,
      isError: false,
      membership: readable,
    });
    const { fetchMock, wrapper } = harness();
    renderHook(() => usePassAudit('p1', 'org1', false), { wrapper });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isolates cached activity when selection and pass organization change', async () => {
    let scope = { orgId: 'org1', isLoading: false, isError: false, membership: readable };
    mocks.useOrgScope.mockImplementation(() => scope);
    const { queryClient, fetchMock, wrapper } = harness();
    const { result, rerender } = renderHook(
      ({ passOrgId }) => usePassAudit('p1', passOrgId, true),
      { wrapper, initialProps: { passOrgId: 'org1' } },
    );

    await waitFor(() => expect(result.current.data?.items[0]?.actorLabel).toBe('Actor org1'));
    scope = { ...scope, orgId: 'org2' };
    rerender({ passOrgId: 'org1' });
    expect(result.current.data).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ passOrgId: 'org2' });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.items[0]?.actorLabel).toBe('Actor org2'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(passKeys.audit('p1', 'org1'))).toMatchObject({
      items: [{ actorLabel: 'Actor org1' }],
    });
    expect(queryClient.getQueryData(passKeys.audit('p1', 'org2'))).toMatchObject({
      items: [{ actorLabel: 'Actor org2' }],
    });
  });
});
