import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { AuditListSchema } from '@/shared/contracts/audit.ts';
import { api } from '@/web/lib/api.ts';
import type { AuditSearch } from './audit-search.ts';

export type AuditQuery = Omit<AuditSearch, 'entry'> & { excludeAction?: string | undefined };

/** Filters change the key; the old rows stay on screen while the new ones load. */
export function useAuditLog(filters: AuditQuery, limit = 50) {
  return useInfiniteQuery({
    queryKey: ['audit', filters, limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/v1/audit', AuditListSchema, {
        query: { ...filters, cursor: pageParam, limit },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}
