import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setCsrfProvider } from '../../../lib/api.ts';
import { useReleaseFlow, useReviewFlow } from './flow-api.ts';

const answer = {
  version: 'v',
  modes: {},
  approved: [],
  release: null,
  state: {
    live: null,
    test: null,
    draft: null,
    review: { state: 'none' },
    alone: true,
    next: null,
  },
};

beforeEach(() => {
  setCsrfProvider(async () => 'csrf');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(answer), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
});
afterEach(() => {
  setCsrfProvider(async () => undefined);
  vi.unstubAllGlobals();
});

function harness() {
  const client = new QueryClient();
  const invalidated = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { invalidated, wrapper };
}

const keys = (spy: ReturnType<typeof harness>['invalidated']) =>
  spy.mock.calls.map(([filters]) => filters?.queryKey);

it('refreshes the join link after a release, which can turn it on', async () => {
  const { invalidated, wrapper } = harness();
  const { result } = renderHook(() => useReleaseFlow('tpl1', 'org1'), { wrapper });
  await act(() => result.current.mutateAsync({ version: 'v', modes: ['test', 'live'] }));
  expect(keys(invalidated)).toContainEqual(['admin', 'join-link', 'tpl1']);
});

it('refreshes the join link after an approval that releases', async () => {
  const { invalidated, wrapper } = harness();
  const { result } = renderHook(() => useReviewFlow('tpl1', 'org1'), { wrapper });
  await act(() => result.current.mutateAsync({ version: 'v', release: true }));
  expect(keys(invalidated)).toContainEqual(['admin', 'join-link', 'tpl1']);
});
