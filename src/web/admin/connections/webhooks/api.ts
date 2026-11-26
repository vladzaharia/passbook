import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { z } from 'zod';
import { OkSchema } from '@/shared/contracts/common.ts';
import { SetupGuideSchema } from '@/shared/contracts/connection-setup.ts';
import type { OverlapHours } from '@/shared/contracts/webhook-secrets.ts';
import { WebhookTestAttemptListSchema } from '@/shared/contracts/webhook-tests.ts';
import {
  type CreateWebhookEndpointSchema,
  type UpdateWebhookEndpointSchema,
  WebhookDeliveryDetailSchema,
  WebhookDeliveryListSchema,
  WebhookEndpointCreatedSchema,
  WebhookEndpointListSchema,
  WebhookEndpointSchema,
  WebhookReplayResultSchema,
  type WebhookReplaySchema,
  WebhookSecretSchema,
  WebhookTestResultSchema,
} from '@/shared/contracts/webhooks.ts';
import { useToolApi, useToolKey, useToolMode } from '../../../lib/tool-api.tsx';

const BASE = '/api/v1/webhook-endpoints';

export type EndpointDraft = z.input<typeof CreateWebhookEndpointSchema>;
export type EndpointPatch = z.input<typeof UpdateWebhookEndpointSchema>;
export type ReplayInput = z.input<typeof WebhookReplaySchema>;
export type DeliveryFilter = 'all' | 'failed' | 'pending';

/**
 * Every call goes through the tool scope (`lib/tool-api.tsx`): admin's session client and its Live/Test
 * mode, or the Workbench's token client, which is Test only. Keys carry the mode, and in a pinned host
 * the client too, so a cached answer never crosses hosts.
 */
/** Keys carry the mode: the endpoints of Live and Test are different sets. */
export const webhookKeys = {
  all: ['admin', 'webhooks'] as const,
  list: (orgId: string | undefined, mode: string) =>
    ['admin', 'webhooks', 'list', orgId ?? null, mode] as const,
  detail: (id: string, mode: string) => ['admin', 'webhooks', 'detail', id, mode] as const,
  deliveries: (id: string, mode: string, filter: DeliveryFilter) =>
    ['admin', 'webhooks', 'deliveries', id, mode, filter] as const,
  tests: (id: string, mode: string) => ['admin', 'webhooks', 'tests', id, mode] as const,
  delivery: (id: string, eventId: string, mode: string) =>
    ['admin', 'webhooks', 'delivery', id, eventId, mode] as const,
};

const refresh = (qc: QueryClient) => qc.invalidateQueries({ queryKey: webhookKeys.all });

export function useWebhookEndpoints(orgId: string | undefined, enabled: boolean) {
  const api = useToolApi();
  const mode = useToolMode();
  const toolKey = useToolKey();
  return useQuery({
    queryKey: [...webhookKeys.list(orgId, mode), ...toolKey],
    queryFn: ({ signal }) => api.get(BASE, WebhookEndpointListSchema, { query: { orgId }, signal }),
    enabled: Boolean(orgId) && enabled,
    // Health moves on its own (a failing endpoint is disabled by a timer).
    refetchInterval: 30_000,
  });
}

export function useWebhookEndpoint(id: string, enabled: boolean) {
  const api = useToolApi();
  const mode = useToolMode();
  const toolKey = useToolKey();
  return useQuery({
    queryKey: [...webhookKeys.detail(id, mode), ...toolKey],
    queryFn: ({ signal }) => api.get(`${BASE}/${id}`, WebhookEndpointSchema, { signal }),
    enabled,
    refetchInterval: 30_000,
  });
}

const STATE_OF: Record<DeliveryFilter, string | undefined> = {
  all: undefined,
  failed: 'failed',
  pending: 'pending',
};

export function useDeliveries(id: string, filter: DeliveryFilter) {
  const api = useToolApi();
  const mode = useToolMode();
  const toolKey = useToolKey();
  return useInfiniteQuery({
    queryKey: [...webhookKeys.deliveries(id, mode, filter), ...toolKey],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get(`${BASE}/${id}/deliveries`, WebhookDeliveryListSchema, {
        query: { state: STATE_OF[filter], cursor: pageParam, limit: 25 },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
}

/** Recent test sends, listed beside the deliveries. */
export function useTestSends(id: string) {
  const api = useToolApi();
  const mode = useToolMode();
  const toolKey = useToolKey();
  return useQuery({
    queryKey: [...webhookKeys.tests(id, mode), ...toolKey],
    queryFn: ({ signal }) =>
      api.get(`${BASE}/${id}/tests`, WebhookTestAttemptListSchema, { signal }),
  });
}

export function useDelivery(id: string, eventId: string | undefined) {
  const api = useToolApi();
  const mode = useToolMode();
  const toolKey = useToolKey();
  return useQuery({
    queryKey: [...webhookKeys.delivery(id, eventId ?? '', mode), ...toolKey],
    queryFn: ({ signal }) =>
      api.get(`${BASE}/${id}/deliveries/${eventId}`, WebhookDeliveryDetailSchema, { signal }),
    enabled: Boolean(eventId),
  });
}

/** The create route's dry run: static and DNS checks, nothing written. */
export function useValidateEndpoint() {
  const api = useToolApi();
  return (draft: EndpointDraft) => api.post(`${BASE}?validate=1`, OkSchema, draft);
}

/**
 * Calls that return a secret are plain async functions, not mutations: a mutation keeps its result
 * in the cache for minutes, and a signing secret must live only in the component that shows it.
 */
export function useSecretCalls() {
  const api = useToolApi();
  const qc = useQueryClient();
  return {
    create: async (draft: EndpointDraft) => {
      const created = await api.post(BASE, WebhookEndpointCreatedSchema, draft);
      await refresh(qc);
      return created;
    },
    rotate: (id: string, overlapHours: OverlapHours) =>
      api.post(`${BASE}/${id}/secret`, WebhookSecretSchema, { overlapHours }),
  };
}

export function useEndpointActions(id: string) {
  const api = useToolApi();
  const qc = useQueryClient();
  const done = () => refresh(qc);
  return {
    update: useMutation({
      mutationFn: (patch: EndpointPatch) =>
        api.patch(`${BASE}/${id}`, WebhookEndpointSchema, patch),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: () => api.delete(`${BASE}/${id}`), onSuccess: done }),
    test: useMutation({
      mutationFn: () => api.post(`${BASE}/${id}/test`, WebhookTestResultSchema),
      // A test can move the endpoint's last success or failure.
      onSuccess: done,
    }),
    replayOne: useMutation({
      mutationFn: (eventId: string) =>
        api.post(`${BASE}/${id}/deliveries/${eventId}/replay`, WebhookReplayResultSchema),
      onSuccess: done,
    }),
    replayRange: useMutation({
      mutationFn: (input: ReplayInput) =>
        api.post(`${BASE}/${id}/replay`, WebhookReplayResultSchema, input),
      onSuccess: done,
    }),
  };
}

/** How many deliveries a replay would send: the same call with `dryRun`, nothing written. */
export function useReplayPreview(id: string, input: ReplayInput, enabled: boolean) {
  const api = useToolApi();
  const mode = useToolMode();
  const toolKey = useToolKey();
  return useQuery({
    queryKey: ['admin', 'webhooks', 'replay-preview', id, mode, input, ...toolKey] as const,
    queryFn: ({ signal }) =>
      api.post(
        `${BASE}/${id}/replay`,
        WebhookReplayResultSchema,
        { ...input, dryRun: true },
        { signal },
      ),
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}

/** The outbound setup guide: what the receiving server does with each delivery. */
export function useOutboundSetup(orgId: string | undefined) {
  const api = useToolApi();
  const toolKey = useToolKey();
  return useQuery({
    queryKey: ['admin', 'webhooks', 'setup', orgId ?? null, ...toolKey] as const,
    queryFn: ({ signal }) =>
      api.get(`${BASE}/setup`, SetupGuideSchema, { query: { orgId }, signal }),
    enabled: Boolean(orgId),
    staleTime: 5 * 60_000,
  });
}
