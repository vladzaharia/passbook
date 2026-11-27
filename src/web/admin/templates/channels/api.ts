import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  PutTemplateChannelsResponseSchema,
  type PutTemplateChannelsSchema,
  ResetTemplatePassesResponseSchema,
} from '@/shared/contracts/channels.ts';
import { api } from '../../../lib/api.ts';
import { path, useChannelRuns, useTemplateChannels } from './reads.ts';

export { useChannelRuns, useTemplateChannels };

type Body = z.input<typeof PutTemplateChannelsSchema>;

/** `dryRun` answers with the effect and saves nothing; a real save refreshes the policy. */
export function usePutTemplateChannels(templateId: string, orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<Body, 'orgId'>) =>
      api.put(path(templateId), PutTemplateChannelsResponseSchema, { ...body, orgId }),
    onSettled: (_data, _error, body) =>
      body.dryRun
        ? undefined
        : client.invalidateQueries({ queryKey: ['admin', 'templates', 'channels'] }),
  });
}

/**
 * Passes with their own choice go back to following the template: the server resets a page at a
 * time, so this repeats while overrides remain and a call still makes progress. Resolves with how
 * many passes were reset and how many overrides are left.
 */
export function useResetPasses(templateId: string, orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (onPage?: (done: number) => void) => {
      let done = 0;
      let remaining = 0;
      for (;;) {
        const res = await api.post(
          `${path(templateId)}/reset-passes`,
          ResetTemplatePassesResponseSchema,
          { orgId },
        );
        done += res.done;
        onPage?.(done);
        remaining = res.remaining;
        if (remaining === 0 || res.done === 0) return { done, remaining };
      }
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['admin'] }),
  });
}
