import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BroadcastSchema } from '@/shared/contracts/broadcasts.ts';
import { MODE_HEADER, type Mode } from '@/shared/contracts/common.ts';
import { TemplateRolloutSchema } from '@/shared/contracts/template-rollout.ts';
import { api } from '../../../lib/api.ts';

const key = (templateId: string, orgId: string, mode: Mode) =>
  ['admin', 'template-rollout', templateId, orgId, mode] as const;

/** Polls while passes are still moving. */
export function useRollout(templateId: string, orgId: string, mode: Mode) {
  return useQuery({
    queryKey: key(templateId, orgId, mode),
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/templates/${encodeURIComponent(templateId)}/rollout`,
        TemplateRolloutSchema,
        {
          headers: { [MODE_HEADER]: mode },
          query: { orgId, mode },
          signal,
        },
      ),
    staleTime: 0,
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && (d.running || d.remaining > d.failedCount) ? 5000 : false;
    },
  });
}

/** A latest-design change run that notifies: the template's change message goes out as each pass moves. */
export function useTellHolders(templateId: string, orgId: string, mode: Mode) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (idempotencyKey: string) =>
      api.post(
        '/api/v1/broadcasts',
        BroadcastSchema,
        {
          orgId,
          kind: 'change',
          name: 'Template update',
          notify: true,
          send: 'now',
          target: { templateIds: [templateId] },
          patch: { $design: true },
        },
        { headers: { [MODE_HEADER]: mode, 'idempotency-key': idempotencyKey } },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: key(templateId, orgId, mode) }),
  });
}
