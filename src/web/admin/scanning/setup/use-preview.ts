import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { ScanSetupIntent } from '@/shared/contracts/scan-setup-intent.ts';
import { dryRunSetup } from './api.ts';

/** The plan Review shows: the server's dry run, refetched as the answers change. */
export function useSetupPreview(intent: ScanSetupIntent, enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'scanning', 'setup', 'preview', intent],
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => dryRunSetup(intent, signal),
  });
}
