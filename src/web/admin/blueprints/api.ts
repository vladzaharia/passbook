import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TemplateDetailSchema,
  TemplateListSchema,
  type UseBlueprintRequest,
} from '@/shared/contracts/index.ts';
import { api } from '../../lib/api.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { useSession } from '../../lib/session.ts';
import { templateKeys, useTemplate, useTemplatePreview } from '../templates/api.ts';

/**
 * Blueprints are platform-wide. A platform administrator reads them as they are; a member reads
 * them through the selected organization (its pass counts, and its branding on the stills).
 */
export function useBlueprintScope(): { orgId: string | undefined; ready: boolean } {
  const { isAdmin } = useSession();
  const scope = useOrgScope();
  if (isAdmin) return { orgId: undefined, ready: true };
  return { orgId: scope.orgId, ready: Boolean(scope.orgId) };
}

/** A small fixed set, so one page holds them all. */
export function useBlueprints() {
  const { orgId, ready } = useBlueprintScope();
  return useQuery({
    queryKey: templateKeys.list({ orgId, blueprint: true }),
    queryFn: ({ signal }) =>
      api.get('/api/v1/templates', TemplateListSchema, {
        query: { blueprint: true, orgId, limit: 200 },
        signal,
      }),
    enabled: ready,
  });
}

export function useBlueprint(id: string) {
  const { orgId, ready } = useBlueprintScope();
  return useTemplate(ready ? id : undefined, orgId);
}

export function useBlueprintPreview(id: string) {
  const { orgId, ready } = useBlueprintScope();
  return useTemplatePreview(ready ? id : '', orgId);
}

/** Makes a template in an org from a blueprint: an exact copy, or the designer's draft. */
export function useUseBlueprint(blueprintId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UseBlueprintRequest) =>
      api.post(`/api/v1/templates/${blueprintId}/use`, TemplateDetailSchema, input),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: templateKeys.all }),
        qc.invalidateQueries({ queryKey: ['palette'] }),
      ]),
  });
}
