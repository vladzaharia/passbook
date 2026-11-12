import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSaveSettings, useSettings } from './queries.ts';

afterEach(() => vi.unstubAllGlobals());

describe('scoped settings', () => {
  it('reads and saves organization settings without platform OIDC details', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ items: [] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(
      () => ({
        settings: useSettings('org:o1'),
        save: useSaveSettings('org:o1'),
      }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.settings.isSuccess).toBe(true));
    await act(async () => {
      await result.current.save.mutateAsync({ 'support.email': 'help@example.com' });
    });
    expect(client.getQueryData(['settings', 'org:o1'])).toEqual({ items: [] });
    const write = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({
      scope: 'org:o1',
      values: { 'support.email': 'help@example.com' },
    });
  });

  it('continues to require OIDC details in platform responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ items: [] }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { result } = renderHook(() => useSettings('platform'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
