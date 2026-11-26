import { useQuery } from '@tanstack/react-query';
import {
  ChannelApplyRunsResponseSchema,
  TemplateChannelsResponseSchema,
} from '@/shared/contracts/channels.ts';
import { useToolApi, useToolKey, useToolMode } from '../../../lib/tool-api.tsx';

/** The channel reads, free of the session client: the designer core and the Workbench import them from here. */
const keys = {
  one: (templateId: string, orgId: string, mode: string) =>
    ['admin', 'templates', 'channels', templateId, orgId, mode] as const,
};

export const path = (templateId: string) =>
  `/api/v1/templates/${encodeURIComponent(templateId)}/channels`;

/** The template's stored policy for the current mode, with what it allows now. */
export function useTemplateChannels(templateId: string, orgId: string, enabled = true) {
  const client = useToolApi();
  const mode = useToolMode();
  const toolKey = useToolKey();
  return useQuery({
    enabled,
    queryKey: [...keys.one(templateId, orgId, mode), ...toolKey],
    queryFn: ({ signal }) =>
      client.get(path(templateId), TemplateChannelsResponseSchema, { query: { orgId }, signal }),
  });
}

const ACTIVE = new Set(['pending', 'running']);

/** The latest runs that applied saved changes; polls while one is pending or running. */
export function useChannelRuns(templateId: string, orgId: string) {
  const client = useToolApi();
  const mode = useToolMode();
  const toolKey = useToolKey();
  return useQuery({
    queryKey: ['admin', 'templates', 'channels', 'runs', templateId, orgId, mode, ...toolKey],
    queryFn: ({ signal }) =>
      client.get(`${path(templateId)}/runs`, ChannelApplyRunsResponseSchema, {
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
