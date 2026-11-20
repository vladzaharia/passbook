import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  BulkPassChannelsResponseSchema,
  CHANNELS,
  ChannelApplyRunsResponseSchema,
  PutTemplateChannelsResponseSchema,
  type PutTemplateChannelsSchema,
  TemplateChannelsResponseSchema,
} from '@/shared/contracts/channels.ts';
import { api } from '../../../lib/api.ts';
import { useMode } from '../../../lib/mode.ts';

/** Only the ids matter when resetting. */
const PassIdsSchema = z.object({
  items: z.array(z.object({ id: z.string() })),
  nextCursor: z.string().nullable(),
});

type Body = z.input<typeof PutTemplateChannelsSchema>;

const keys = {
  one: (templateId: string, orgId: string, mode: string) =>
    ['admin', 'templates', 'channels', templateId, orgId, mode] as const,
};

const path = (templateId: string) => `/api/v1/templates/${encodeURIComponent(templateId)}/channels`;

/** The template's stored policy for the current mode, with what it allows now. */
export function useTemplateChannels(templateId: string, orgId: string) {
  const mode = useMode();
  return useQuery({
    queryKey: keys.one(templateId, orgId, mode),
    queryFn: ({ signal }) =>
      api.get(path(templateId), TemplateChannelsResponseSchema, { query: { orgId }, signal }),
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
  const mode = useMode();
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
 * Every pass of the template (current mode) goes back to following it: the bulk reset, 100 ids at
 * a time. Resolves with how many passes were reset.
 */
export function useApplyToExistingPasses(templateId: string, orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      let done = 0;
      let cursor: string | undefined;
      do {
        const page = await api.get('/api/v1/passes', PassIdsSchema, {
          query: { templateId, orgId, limit: 100, cursor },
        });
        const ids = page.items.map((p) => p.id);
        if (ids.length > 0) {
          const res = await api.post(
            '/api/v1/passes/bulk/channels',
            BulkPassChannelsResponseSchema,
            {
              action: 'reset',
              channels: [...CHANNELS],
              ids,
              orgId,
            },
          );
          if (res.skipped.length > 0) throw new Error('skipped');
          done += res.done;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return done;
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['admin'] }),
  });
}
