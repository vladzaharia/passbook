import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Toaster } from '../ui/toaster.tsx';
import { TooltipProvider } from '../ui/tooltip.tsx';
import { OrgFilterProvider } from './org-filter.tsx';
import { ThemeProvider } from './theme.tsx';

export function AppProviders({ queryClient, children }: { queryClient: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={300}>
          <OrgFilterProvider>
            {children}
            <Toaster />
          </OrgFilterProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
