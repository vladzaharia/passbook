import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Toaster } from '../ui/toaster.tsx';
import { TooltipProvider } from '../ui/tooltip.tsx';
import { CoreProviders } from './core-providers.tsx';

export function AppProviders({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <CoreProviders queryClient={queryClient}>
      <TooltipProvider delayDuration={400} skipDelayDuration={300}>
        {children}
        <Toaster />
      </TooltipProvider>
    </CoreProviders>
  );
}
