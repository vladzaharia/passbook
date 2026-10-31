import { useQuery } from '@tanstack/react-query';
import { PassListSchema } from '@/shared/contracts/passes.ts';
import { OrgListSchema } from '@/shared/contracts/orgs.ts';
import { api } from './api.ts';

const MIN_QUERY = 2;

/** Command palette pass search. Disabled until the query has 2+ characters. */
export function useRecentPassSearch(q: string, orgId?: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ['palette', 'passes', term, orgId ?? null],
    queryFn: ({ signal }) =>
      api.get('/api/v1/passes', PassListSchema, {
        query: { q: term, orgId, limit: 6 },
        signal,
      }),
    enabled: term.length >= MIN_QUERY,
    staleTime: 15_000,
  });
}

export function useOrgOptions(enabled = true) {
  return useQuery({
    queryKey: ['orgs', 'options'],
    queryFn: ({ signal }) => api.get('/api/v1/orgs', OrgListSchema, { query: { limit: 200 }, signal }),
    enabled,
    staleTime: 60_000,
  });
}
