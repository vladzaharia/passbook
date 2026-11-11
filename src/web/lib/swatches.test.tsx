import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPreviewBatches } from './preview-batch.ts';
import { useSwatches } from './swatches.ts';

const deferred = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
};

function response(color: string): Response {
  return new Response(
    JSON.stringify({
      items: [
        {
          id: 'tpl',
          passJson: { backgroundColor: color, foregroundColor: '#fff' },
          warnings: [],
          assetBaseUrl: '/api/v1/templates/tpl/versions/v1/assets?rev=1#preview',
          assetNames: ['strip@2x.png'],
        },
      ],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => {
  clearPreviewBatches();
  vi.unstubAllGlobals();
});

describe('useSwatches', () => {
  it('clears the old organization immediately and scopes its replacement and asset URL', async () => {
    const next = deferred.withResolvers<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const org = new URL(String(input), 'http://localhost').searchParams.get('orgId');
      return org === 'org-b' ? next.promise : response('#aabbcc');
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(({ orgId }) => useSwatches(['tpl'], orgId), {
      initialProps: { orgId: 'org-a' },
      wrapper,
    });
    await waitFor(() => expect(result.current.get('tpl')?.background).toBe('#aabbcc'));
    expect(result.current.get('tpl')?.image).toBe(
      '/api/v1/templates/tpl/versions/v1/assets/strip%402x.png?rev=1&orgId=org-a#preview',
    );

    rerender({ orgId: 'org-b' });
    expect(result.current.has('tpl')).toBe(false);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      next.resolve(response('#112233'));
    });
    await waitFor(() => expect(result.current.get('tpl')?.background).toBe('#112233'));
    expect(result.current.get('tpl')?.image).toBe(
      '/api/v1/templates/tpl/versions/v1/assets/strip%402x.png?rev=1&orgId=org-b#preview',
    );
  });
});
