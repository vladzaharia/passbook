import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BroadcastSchema } from '@/shared/contracts/broadcasts.ts';
import { MODE_HEADER, type Mode } from '@/shared/contracts/common.ts';
import {
  type TemplateRollout,
  TemplateRolloutSchema,
} from '@/shared/contracts/template-rollout.ts';
import { api } from '../../../lib/api.ts';

const key = (templateId: string, orgId: string, mode: Mode) =>
  ['admin', 'template-rollout', templateId, orgId, mode] as const;

/** Polls while passes are still moving. */
export function useRollout(templateId: string, orgId: string, mode: Mode, enabled: boolean) {
  return useQuery({
    enabled,
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

type Tell = NonNullable<TemplateRollout['tell']>;

/**
 * Tell holders: before passes move, a latest-design change run that notifies; after, a message to the
 * template's passes with `text`. Both are the ordinary create, so its checks apply.
 */
export function useTellHolders(templateId: string, orgId: string, mode: Mode) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ tell, text, idem }: { tell: Tell; text: string; idem: string }) =>
      api.post(
        '/api/v1/broadcasts',
        BroadcastSchema,
        {
          orgId,
          name: 'Template update',
          send: 'now',
          target: { templateIds: [templateId] },
          ...(tell.path === 'change'
            ? { kind: 'change', notify: true, patch: { $design: true } }
            : { kind: 'message', notify: true, patch: { message: text } }),
        },
        { headers: { [MODE_HEADER]: mode, 'idempotency-key': idem } },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: key(templateId, orgId, mode) }),
  });
}
