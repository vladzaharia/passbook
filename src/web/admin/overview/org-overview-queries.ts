import { useQuery } from '@tanstack/react-query';
import { MetricsOverviewSchema, OrgActivitySchema } from '@/shared/contracts/metrics.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';
import type { Range } from './range.ts';

/** An organization's passes, wallet state and scans by template. A range change keeps the old numbers. */
export function useOrgActivity(
  orgId: string | undefined,
  principal: string | undefined,
  range: Range,
) {
  const mode = useMode();
  return useQuery({
    queryKey: ['metrics', 'org-activity', principal ?? null, orgId ?? null, mode, range],
    enabled: orgId !== undefined && principal !== undefined,
    queryFn: ({ signal }) =>
      api.get('/api/v1/metrics/activity', OrgActivitySchema, { query: { orgId, range }, signal }),
    staleTime: 30_000,
    placeholderData: (previous, query) =>
      query?.queryKey[2] === principal && query?.queryKey[3] === orgId ? previous : undefined,
  });
}

/** The first-run counts, read only while the organization has no passes. */
export function useOrgSetup(orgId: string | undefined, principal: string | undefined, on: boolean) {
  const mode = useMode();
  return useQuery({
    queryKey: ['metrics', 'org-setup', principal ?? null, orgId ?? null, mode],
    enabled: on && orgId !== undefined && principal !== undefined,
    queryFn: ({ signal }) =>
      api.get('/api/v1/metrics/overview', MetricsOverviewSchema, {
        query: { orgId, range: '24h' },
        signal,
      }),
    // Every visit refetches so a step ticks as soon as it is done.
    staleTime: 0,
  });
}
