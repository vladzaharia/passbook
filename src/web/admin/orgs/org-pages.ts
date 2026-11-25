import { useInfiniteQuery } from '@tanstack/react-query';
import { api, listQuery } from '@/web/lib/api.ts';
import { PlatformOrgListSchema } from './queries.ts';

/**
 * The Organizations page: newest first, 50 at a time. Kept out of queries.ts, which most admin
 * chunks share: there it changed how the build splits the initial bundle (+5 kB gzip).
 */
export type SandboxFilter = 'hide' | 'show' | 'only';

export function useOrgPages(q?: string, sandboxes: SandboxFilter = 'hide') {
  return useInfiniteQuery(
    listQuery({
      queryKey: ['orgs', 'pages', q ?? '', sandboxes],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
        api.get('/api/v1/orgs', PlatformOrgListSchema, {
          query: {
            q,
            cursor: pageParam,
            limit: 50,
            sandboxes: sandboxes === 'hide' ? undefined : sandboxes,
          },
          signal,
        }),
      getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    }),
  );
}
