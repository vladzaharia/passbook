import { useQuery } from '@tanstack/react-query';
import { OrgPlanSchema } from '@/shared/contracts/org-plan.ts';
import { api } from '@/web/lib/api.ts';

/** The organization's plan: limits with use, features, footer. Use moves slowly, so a few minutes stale is fine. */
export function useOrgPlan(orgId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['orgs', 'plan', orgId ?? null],
    enabled: enabled && orgId !== undefined,
    queryFn: ({ signal }) =>
      api.get(`/api/v1/orgs/${encodeURIComponent(orgId ?? '')}/plan`, OrgPlanSchema, { signal }),
    staleTime: 5 * 60_000,
  });
}
