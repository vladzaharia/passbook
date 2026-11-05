import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ThemeProvider } from './theme.tsx';

/**
 * Query and theme: what every document needs. /scan stops here, because it has no tooltips or
 * toasts and its initial bundle is budgeted (tools/check-bundle.ts). The SPA adds its chrome in
 * providers.tsx.
 */
export function CoreProviders({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}
