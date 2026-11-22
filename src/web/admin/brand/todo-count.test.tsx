import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { todoCount } from '@/shared/org-setup-checks.ts';
import { newOrgFacts, viewOf } from '@/shared/pass-setup-test-fixtures.ts';
import { setCsrfProvider } from '../../lib/api.ts';
import { useBrandStep } from './overview-step.tsx';
import { BrandCount } from './sidebar-count.tsx';

const view = viewOf(newOrgFacts());
const expected = todoCount(view.checks);

beforeEach(() => {
  setCsrfProvider(async () => 'csrf');
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(view), {
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

it('counts warnings and errors, never suggestions, the same in the sidebar and on Overview', async () => {
  expect(expected).toBeGreaterThan(0);
  expect(view.checks.length).toBeGreaterThan(expected);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<BrandCount orgId="org1" />, { wrapper });
  const step = renderHook(() => useBrandStep('org1'), { wrapper });
  await waitFor(() => expect(step.result.current?.count).toBe(expected));
  expect(await screen.findByText(String(expected))).toBeInTheDocument();
});
