import type { QueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { Toaster } from '../ui/toaster.tsx';
import { loadTooltips, TooltipProvider } from '../ui/tooltip.tsx';
import { CoreProviders } from './core-providers.tsx';

export function AppProviders({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children?: ReactNode;
}) {
  useEffect(() => {
    const idle = () => void loadTooltips();
    const id = window.setTimeout(idle, 300);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <CoreProviders queryClient={queryClient}>
      <TooltipProvider delayDuration={400}>
        {children}
        <Toaster belowTopBar />
      </TooltipProvider>
    </CoreProviders>
  );
}
