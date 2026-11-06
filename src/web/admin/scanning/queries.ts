import { queryOptions, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ScannerSetupListSchema, ScannerSetupSchema } from '@/shared/contracts/scan-setups.ts';
import { api, listQuery } from '@/web/lib/api.ts';

/** The scanners page polls this often while it is visible; a changed pill rings once. */
export const SCANNERS_POLL_MS = 30_000;

export const scanningKeys = {
  all: ['admin', 'scanning'] as const,
  scanners: ['admin', 'scanning', 'scanners'] as const,
  scannerList: (orgId: string | undefined, revoked: boolean) =>
    ['admin', 'scanning', 'scanners', 'list', orgId ?? null, revoked] as const,
  scanner: (id: string) => ['admin', 'scanning', 'scanners', 'detail', id] as const,
  pairing: (id: string) => ['admin', 'scanning', 'scanners', 'pairing', id] as const,
};

/**
 * Scanners page by cursor for the top-bar org, in the console's mode. Revoked scanners load
 * apart, behind "Show revoked (n)". Refetches while visible (react-query pauses in the background).
 */
export function useScannerPages(orgId: string | undefined, revoked: boolean, enabled = true) {
  return useInfiniteQuery(
    listQuery({
      queryKey: scanningKeys.scannerList(orgId, revoked),
      enabled,
      refetchInterval: SCANNERS_POLL_MS,
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
        api.get('/api/v1/scan-setups', ScannerSetupListSchema, {
          query: { orgId, status: revoked ? 'revoked' : undefined, cursor: pageParam, limit: 50 },
          signal,
        }),
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    }),
  );
}

export const scannerQuery = (id: string, refetchInterval?: number) =>
  queryOptions({
    queryKey: scanningKeys.scanner(id),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/scan-setups/${encodeURIComponent(id)}`, ScannerSetupSchema, { signal }),
    ...(refetchInterval ? { refetchInterval } : {}),
  });

export function useScanner(id: string) {
  return useQuery(scannerQuery(id, SCANNERS_POLL_MS));
}
