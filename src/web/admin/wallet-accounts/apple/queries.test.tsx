import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useIdentityOptions } from './queries.ts';

afterEach(() => vi.unstubAllGlobals());

describe('identity options', () => {
  it('requests options by default and suppresses requests until enabled', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const { result, rerender, unmount } = renderHook(({ enabled }) => useIdentityOptions(enabled), {
      wrapper: Wrapper,
      initialProps: { enabled: false },
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/v1/identities?limit=200');
    unmount();
    client.clear();
    const defaultHook = renderHook(() => useIdentityOptions(), { wrapper: Wrapper });
    await waitFor(() => expect(defaultHook.result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
