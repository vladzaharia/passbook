import { useInfiniteQuery } from '@tanstack/react-query';
import { OrgListSchema } from '@/shared/contracts/orgs.ts';
import { api, listQuery } from '@/web/lib/api.ts';

/**
 * The Organizations page: newest first, 50 at a time. Kept out of queries.ts, which most admin
 * chunks share: there it changed how the build splits the initial bundle (+5 kB gzip).
 */
export function useOrgPages(q?: string) {
  return useInfiniteQuery(
    listQuery({
      queryKey: ['orgs', 'pages', q ?? ''],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
        api.get('/api/v1/orgs', OrgListSchema, {
          query: { q, cursor: pageParam, limit: 50 },
          signal,
        }),
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    }),
  );
}
