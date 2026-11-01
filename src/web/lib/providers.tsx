import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Toaster } from '../ui/toaster.tsx';
import { TooltipProvider } from '../ui/tooltip.tsx';
import { OrgScopeProvider } from './org-filter.tsx';
import { ThemeProvider } from './theme.tsx';

export function AppProviders({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={400} skipDelayDuration={300}>
          <OrgScopeProvider>
            {children}
            <Toaster />
          </OrgScopeProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
