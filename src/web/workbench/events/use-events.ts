import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { pollEvery } from '../../lib/poll-backoff.ts';
import { useToolApi, useToolKey } from '../../lib/tool-api.tsx';
import { useToolHost } from '../host/tool-host.tsx';
import { type EventsApi, eventsApi } from './api.ts';
import { workbenchDeliveryHost } from './host-links.tsx';

export const ENDPOINTS_POLL_MS = 10_000;
/** Deliveries and captures. */
export const READ_POLL_MS = 8000;

/** The Events tool's calls on this context's token client. */
export function useEventsApi(): EventsApi {
  const tool = useToolApi();
  const { orgId } = useToolHost().context;
  return useMemo(() => eventsApi(tool, orgId), [tool, orgId]);
}

/** The shared delivery parts' host in this context. The server decides who may manage; a refusal is shown. */
export function useDeliveryHost() {
  const { orgId } = useToolHost().context;
  return useMemo(() => workbenchDeliveryHost(orgId, true), [orgId]);
}

/** The context's endpoints, read again every 10 s: a failing endpoint is disabled by a timer. */
export function useEndpoints() {
  const api = useEventsApi();
  const key = useToolKey();
  return useQuery({
    queryKey: ['workbench', 'events', 'endpoints', ...key],
    queryFn: () => api.endpoints().then((r) => r.items),
    refetchInterval: pollEvery(ENDPOINTS_POLL_MS),
  });
}

/** One event's deliveries across endpoints, read again while it is open. */
export function useEventDeliveries(eventId: string) {
  const api = useEventsApi();
  const key = useToolKey();
  return useQuery({
    queryKey: ['workbench', 'events', 'deliveries', eventId, ...key],
    queryFn: () => api.eventDeliveries(eventId).then((r) => r.items),
    refetchInterval: pollEvery(READ_POLL_MS),
  });
}

/** One endpoint's stored requests, newest first (a capture endpoint's own list). */
export function useCaptures(endpointId: string | undefined) {
  const api = useEventsApi();
  const key = useToolKey();
  return useQuery({
    queryKey: ['workbench', 'events', 'captures', endpointId, ...key],
    queryFn: () => api.captures(endpointId as string).then((r) => r.items),
    enabled: Boolean(endpointId),
    refetchInterval: pollEvery(READ_POLL_MS),
  });
}
