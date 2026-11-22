import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Mode } from '@/shared/contracts/common.ts';
import {
  ReleasePlanSchema,
  ReleaseResultSchema,
  type ReleaseTemplate,
  ReviewResultSchema,
  type ReviewTemplate,
} from '@/shared/contracts/template-release-flow.ts';
import { api } from '../../../lib/api.ts';
import { reviewInboxKey } from '../../../lib/template-reviews.ts';

const base = (templateId: string) => `/api/v1/templates/${encodeURIComponent(templateId)}/release`;

/** What releasing `version` would do, per mode: read-only, fetched when the dialog opens. */
export function useReleasePlan(templateId: string, orgId: string, version: string, modes: Mode[]) {
  return useQuery({
    queryKey: ['admin', 'template-releases', templateId, orgId, 'plan', version, modes],
    queryFn: ({ signal }) =>
      api.post(
        base(templateId),
        ReleasePlanSchema,
        { orgId, version, modes },
        { query: { dryRun: 'true' }, signal },
      ),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** One call: Try is `modes: ['test']`, Request review is `request: true`. A key per attempt. */
export function useReleaseFlow(templateId: string, orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<ReleaseTemplate, 'orgId'>) =>
      api.post(
        base(templateId),
        ReleaseResultSchema,
        { ...body, orgId },
        { headers: { 'idempotency-key': crypto.randomUUID() } },
      ),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['admin', 'templates'] }),
        client.invalidateQueries({ queryKey: ['admin', 'template-releases', templateId] }),
      ]),
  });
}

/** A reviewer's approval of a version for both modes, and its release when `release` is set. */
export function useReviewFlow(templateId: string, orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<ReviewTemplate, 'orgId'>) =>
      api.post(`/api/v1/templates/${encodeURIComponent(templateId)}/review`, ReviewResultSchema, {
        ...body,
        orgId,
      }),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['admin', 'templates'] }),
        client.invalidateQueries({ queryKey: ['admin', 'template-releases', templateId] }),
        client.invalidateQueries({ queryKey: reviewInboxKey(orgId) }),
      ]),
  });
}
