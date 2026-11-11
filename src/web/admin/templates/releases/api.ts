import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MODE_HEADER } from '@/shared/contracts/common.ts';
import {
  type ApproveTemplateCandidate,
  ApproveTemplateCandidateSchema,
  type CreateTemplateCandidate,
  CreateTemplateCandidateSchema,
  type PublishTemplateRelease,
  PublishTemplateReleaseSchema,
  type RollbackTemplateRelease,
  RollbackTemplateReleaseSchema,
  TemplateApprovalSchema,
  TemplateCandidateListSchema,
  TemplateCandidateSchema,
  TemplateReleaseImpactSchema,
  TemplateReleaseListSchema,
  TemplateReleaseSchema,
  type TemplateReleaseScope,
} from '@/shared/contracts/template-releases.ts';
import { api } from '../../../lib/api.ts';
import { isApiError } from '../../../lib/errors.ts';

const key = (templateId: string, scope: TemplateReleaseScope) =>
  ['admin', 'template-releases', templateId, scope.orgId, scope.mode, scope.provider] as const;

/** Both lists are scoped independently of the browser's current mode header. */
export function useReleaseLists(templateId: string, scope: TemplateReleaseScope) {
  const base = `/api/v1/templates/${encodeURIComponent(templateId)}`;
  const opts = { headers: { [MODE_HEADER]: scope.mode } };
  const releases = useQuery({
    queryKey: [...key(templateId, scope), 'releases'],
    queryFn: ({ signal }) =>
      api.get(`${base}/releases`, TemplateReleaseListSchema, {
        ...opts,
        query: scope,
        signal,
      }),
  });
  const candidates = useQuery({
    queryKey: [...key(templateId, scope), 'candidates'],
    queryFn: ({ signal }) =>
      api.get(`${base}/candidates`, TemplateCandidateListSchema, {
        ...opts,
        query: scope,
        signal,
      }),
  });
  return { releases, candidates };
}

/** What making `version` current would change; read-only, fetched when a dialog opens. */
export function useReleaseImpact(templateId: string, scope: TemplateReleaseScope, version: string) {
  return useQuery({
    queryKey: [...key(templateId, scope), 'impact', version],
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/templates/${encodeURIComponent(templateId)}/releases/impact`,
        TemplateReleaseImpactSchema,
        { headers: { [MODE_HEADER]: scope.mode }, query: { ...scope, version }, signal },
      ),
    staleTime: 0,
  });
}

/** A mutation never retries a CAS operation with a new head on the user's behalf. */
export function useReleaseActions(templateId: string, scope: TemplateReleaseScope) {
  const client = useQueryClient();
  const base = `/api/v1/templates/${encodeURIComponent(templateId)}`;
  const opts = { headers: { [MODE_HEADER]: scope.mode } };
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: key(templateId, scope) }),
      client.invalidateQueries({ queryKey: ['admin', 'templates'] }),
    ]);
  const onError = (error: unknown) => {
    if (isApiError(error) && error.isConflict) void refresh();
  };
  const create = useMutation({
    mutationFn: (body: CreateTemplateCandidate) =>
      api.post(
        `${base}/candidates`,
        TemplateCandidateSchema,
        CreateTemplateCandidateSchema.parse(body),
        opts,
      ),
    onSuccess: refresh,
    onError,
  });
  const approve = useMutation({
    mutationFn: ({ candidateId, body }: { candidateId: string; body: ApproveTemplateCandidate }) =>
      api.post(
        `${base}/candidates/${encodeURIComponent(candidateId)}/approve`,
        TemplateApprovalSchema,
        ApproveTemplateCandidateSchema.parse(body),
        opts,
      ),
    onSuccess: refresh,
    onError,
  });
  const publish = useMutation({
    mutationFn: (body: PublishTemplateRelease) =>
      api.post(
        `${base}/releases`,
        TemplateReleaseSchema,
        PublishTemplateReleaseSchema.parse(body),
        opts,
      ),
    onSuccess: refresh,
    onError,
  });
  const rollback = useMutation({
    mutationFn: (body: RollbackTemplateRelease) =>
      api.post(
        `${base}/releases/rollback`,
        TemplateReleaseSchema,
        RollbackTemplateReleaseSchema.parse(body),
        opts,
      ),
    onSuccess: refresh,
    onError,
  });
  return { create, approve, publish, rollback };
}
