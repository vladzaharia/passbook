import type { WebhookCaptureDto } from '@/shared/contracts/webhook-captures.ts';
import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';
import type { DeliveryRowData } from '../../ui/webhooks/delivery-types.ts';
import type { EventDelivery } from './types.ts';

/** The words of an endpoint in a row and a heading. */
export const endpointLabel = (e: WebhookEndpointDto): string =>
  e.target === 'capture' ? 'Capture endpoint' : e.description || e.urlMasked;

/** The request and pass a capture's body names; a broken body names none. */
export function factsOfBody(body: string): {
  requestId: string | null;
  passId: string | null;
  externalId: string | null;
} {
  let p: { requestId?: unknown; pass?: { id?: unknown; externalId?: unknown } | null } = {};
  try {
    p = JSON.parse(body);
  } catch {
    // A capture is always our own JSON; a broken one just has nothing to link.
  }
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    requestId: text(p.requestId),
    passId: text(p.pass?.id),
    externalId: text(p.pass?.externalId),
  };
}

const ok = (status: number) => status >= 200 && status < 300;

/** A capture as a row of the shared delivery list: stored, so it is delivered or failed by its answer. */
export function captureRow(c: WebhookCaptureDto, endpoint: WebhookEndpointDto): DeliveryRowData {
  const f = factsOfBody(c.body);
  return {
    eventId: c.eventId,
    type: c.type,
    passId: f.passId ?? '',
    externalId: f.externalId,
    state: ok(c.status) ? 'delivered' : 'failed',
    attempts: 1,
    nextAt: c.createdAt,
    lastStatus: c.status,
    lastError: null,
    lastAttemptAt: c.createdAt,
    finishedAt: c.createdAt,
    replays: 0,
    endpointId: endpoint.id,
    endpointName: endpointLabel(endpoint),
    endpointStatus: endpoint.status,
    rowId: c.id,
    ...(c.trigger === 'test' ? { test: true as const } : {}),
  };
}

/** An event's delivery to one endpoint, named for the list that spans endpoints. */
export function eventDeliveryRow(
  d: EventDelivery,
  endpoints: readonly WebhookEndpointDto[],
): DeliveryRowData {
  const endpoint = endpoints.find((e) => e.id === d.endpointId);
  const { target: _target, ...rest } = d;
  return {
    ...rest,
    endpointName: endpoint
      ? endpointLabel(endpoint)
      : d.target === 'capture'
        ? 'Capture endpoint'
        : '—',
    ...(endpoint ? { endpointStatus: endpoint.status } : {}),
  };
}
