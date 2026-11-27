import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { PassListSchema } from '@/shared/contracts/passes.ts';
import { api } from '../../lib/api.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { readablePassOrgs } from '../../lib/org-lists.ts';
import { type PassFilters, passKeys } from './api.ts';

/** Which list: one organization (the URL's), or every organization the caller can read. */
export type PassScope = { kind: 'org' } | { kind: 'all' };

export function usePassList(filters: PassFilters, passScope: PassScope = { kind: 'org' }) {
  const scope = useOrgScope();
  const all = passScope.kind === 'all';
  const ready = !scope.isLoading && !scope.isError;
  const readable = useMemo(
    () => (all && ready ? readablePassOrgs(scope.memberships).map((m) => m.orgId) : []),
    [all, ready, scope.memberships],
  );
  // Only readable ids go out: a stale link naming another organization would be refused whole.
  const orgIds = useMemo(() => {
    const chosen = (filters.orgIds ?? []).filter((id) => readable.includes(id));
    return chosen.length ? chosen : undefined;
  }, [filters.orgIds, readable]);
  const allowed = all
    ? readable.length >= 2
    : Boolean(
        ready &&
          filters.orgId &&
          filters.orgId === scope.orgId &&
          scope.membership?.capabilities.includes('passes:read'),
      );
  const orgId = all ? 'all' : allowed ? scope.orgId : undefined;
  return useInfiniteQuery({
    queryKey: passKeys.list({ ...filters, orgId, orgIds }),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) => {
      if (!allowed || !orgId) throw new Error('Choose an authorized organization.');
      const { noScanDays, match, orgIds: _ids, ...rest } = filters;
      return api.get('/api/v1/passes', PassListSchema, {
        query: {
          ...rest,
          ...(noScanDays ? { scan: JSON.stringify({ noScanDays }) } : {}),
          ...(match ? { match: JSON.stringify(match) } : {}),
          ...(all && orgIds ? { orgIds: orgIds.join(',') } : {}),
          ...(pageParam ? {} : { count: true }),
          orgId,
          cursor: pageParam,
          limit: 50,
        },
        signal,
      });
    },
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    enabled: allowed,
    // Keep filtered rows only while the selected, authorized organization stays the same.
    placeholderData: (previous, query) =>
      allowed && query?.queryKey[3].orgId === orgId ? previous : undefined,
  });
}
