import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  ChannelApplyRunsResponseSchema,
  PutTemplateChannelsResponseSchema,
  type PutTemplateChannelsSchema,
  ResetTemplatePassesResponseSchema,
  TemplateChannelsResponseSchema,
} from '@/shared/contracts/channels.ts';
import { api } from '../../../lib/api.ts';
import { useToolApi, useToolMode } from '../../../lib/tool-api.tsx';

type Body = z.input<typeof PutTemplateChannelsSchema>;

const keys = {
  one: (templateId: string, orgId: string, mode: string) =>
    ['admin', 'templates', 'channels', templateId, orgId, mode] as const,
};

const path = (templateId: string) => `/api/v1/templates/${encodeURIComponent(templateId)}/channels`;

/** The template's stored policy for the current mode, with what it allows now. */
export function useTemplateChannels(templateId: string, orgId: string, enabled = true) {
  const client = useToolApi();
  const mode = useToolMode();
  return useQuery({
    enabled,
    queryKey: keys.one(templateId, orgId, mode),
    queryFn: ({ signal }) =>
      client.get(path(templateId), TemplateChannelsResponseSchema, { query: { orgId }, signal }),
  });
}

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

const ACTIVE = new Set(['pending', 'running']);

/** The latest runs that applied saved changes; polls while one is pending or running. */
export function useChannelRuns(templateId: string, orgId: string) {
  const mode = useToolMode();
  return useQuery({
    queryKey: ['admin', 'templates', 'channels', 'runs', templateId, orgId, mode] as const,
    queryFn: ({ signal }) =>
      api.get(`${path(templateId)}/runs`, ChannelApplyRunsResponseSchema, {
        query: { orgId },
        signal,
      }),
    // A run held by a window changes slowly: look every 30 s, otherwise every 5 s while one is active.
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.waiting)
        ? 30_000
        : q.state.data?.some((r) => ACTIVE.has(r.state))
          ? 5000
          : false,
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
