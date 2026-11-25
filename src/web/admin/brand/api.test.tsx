import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readyFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { json } from '@/web/lib/test-utils.tsx';
import { useSavePassSetup } from './api.ts';

afterEach(() => vi.unstubAllGlobals());

describe('useSavePassSetup', () => {
  it("reloads the org's brand kit, which the designer's paper preview reads for the footer", async () => {
    const view = viewOf(readyFacts());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          dryRun: false,
          view,
          diff: [],
          impact: { passesToUpdate: 0, channelStops: [], enrolments: [] },
        }),
      ),
    );
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSavePassSetup('o1'), { wrapper });
    result.current.mutate({ expectedRevision: view.revision, brand: { mark: 'small' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'brand', 'o1'] });
  });
});
