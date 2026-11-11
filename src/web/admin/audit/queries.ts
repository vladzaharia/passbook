import { useInfiniteQuery } from '@tanstack/react-query';
import { AuditListSchema } from '@/shared/contracts/audit.ts';
import { api } from '@/web/lib/api.ts';
import { useSession } from '@/web/lib/session.ts';
import type { AuditSearch } from './audit-search.ts';

export type AuditQuery = Omit<AuditSearch, 'entry'> & { excludeAction?: string | undefined };

/** Keep rows during filter changes only within the same principal and organization filter. */
export function usePlatformAuditLog(filters: AuditQuery, limit = 50, staleTime?: number) {
  const { filterOrgId, ...rest } = filters;
  const session = useSession();
  const principal = session.isAdmin && !session.isError ? session.authed?.user.id : undefined;
  return useInfiniteQuery({
    queryKey: ['audit', 'platform', principal ?? null, filters, limit],
    enabled: principal !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/v1/audit/platform', AuditListSchema, {
        query: { ...rest, orgId: filterOrgId, cursor: pageParam, limit },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous, query) => {
      const previousFilters = query?.queryKey[3] as AuditQuery | undefined;
      return principal !== undefined &&
        query?.queryKey[2] === principal &&
        previousFilters?.filterOrgId === filterOrgId
        ? previous
        : undefined;
    },
    ...(staleTime === undefined ? {} : { staleTime }),
  });
}
