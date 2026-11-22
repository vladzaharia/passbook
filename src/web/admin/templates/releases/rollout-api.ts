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

/** Holders hear the message for a week, then it clears. */
export const TELL_CLEAR_MS = 7 * 24 * 3_600_000;

/**
 * Polls every 15 s, and only while passes are moving or a first rebuild is still due. Once a rebuild
 * has run (or stalled) and finished, nothing changes on its own, so it stops.
 */
export function useRollout(templateId: string, orgId: string, mode: Mode, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: key(templateId, orgId, mode),
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/templates/${encodeURIComponent(templateId)}/rollout`,
        TemplateRolloutSchema,
        { headers: { [MODE_HEADER]: mode }, query: { orgId, mode }, signal },
      ),
    staleTime: 0,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (!d || d.stalled) return false;
      return d.running || (d.runId === null && d.remaining > d.failedCount) ? 15_000 : false;
    },
  });
}

/**
 * Tell holders: a message to the passes that are on the release now, cleared after a week. One send
 * per release: the server's key is the release's.
 */
export function useTellHolders(
  templateId: string,
  orgId: string,
  mode: Mode,
  version: string,
  name: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ tell, text }: { tell: NonNullable<TemplateRollout['tell']>; text: string }) =>
      api.post(
        '/api/v1/broadcasts',
        BroadcastSchema,
        {
          orgId,
          kind: 'message',
          name: name.slice(0, 80),
          notify: true,
          send: 'now',
          clearAfter: TELL_CLEAR_MS,
          target: { templateIds: [templateId], version },
          patch: { message: text },
        },
        { headers: { [MODE_HEADER]: mode, 'idempotency-key': tell.key } },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: key(templateId, orgId, mode) }),
  });
}
