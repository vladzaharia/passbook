import { useInfiniteQuery } from '@tanstack/react-query';
import { AuditListSchema } from '@/shared/contracts/audit.ts';
import { api } from '@/web/lib/api.ts';
import type { AuditSearch } from './audit-search.ts';

export function useAuditLog(search: AuditSearch, limit = 50) {
  const { entry: _entry, ...filters } = search;
  return useInfiniteQuery({
    queryKey: ['audit', filters, limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/v1/audit', AuditListSchema, {
        query: { ...filters, cursor: pageParam, limit },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
