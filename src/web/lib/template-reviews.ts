import { useQuery } from '@tanstack/react-query';
import { TemplateReviewListSchema } from '@/shared/contracts/template-release-flow.ts';
import { api } from './api.ts';

export const reviewInboxKey = (orgId: string | undefined) =>
  ['admin', 'template-reviews', orgId ?? null] as const;

/** Open review requests the caller may act on in one organization: the "Needs your review" inbox. */
export function useTemplateReviews(orgId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: reviewInboxKey(orgId),
    enabled: enabled && Boolean(orgId),
    queryFn: ({ signal }) =>
      api.get('/api/v1/template-reviews', TemplateReviewListSchema, {
        query: { state: 'open', ...(orgId ? { orgId } : {}) },
        signal,
      }),
    staleTime: 30_000,
  });
}
