import {
  CaptureEndpointCreatedSchema,
  CaptureReplayResultSchema,
  CaptureSecretSchema,
  WebhookCaptureListSchema,
  WebhookCaptureSchema,
} from '@/shared/contracts/webhook-captures.ts';
import type { OverlapHours } from '@/shared/contracts/webhook-secrets.ts';
import { WebhookTestAttemptListSchema } from '@/shared/contracts/webhook-tests.ts';
import {
  EventFeedPageSchema,
  WebhookEndpointListSchema,
  WebhookEndpointSchema,
  WebhookEventSchema,
  WebhookSecretSchema,
  WebhookTestResultSchema,
} from '@/shared/contracts/webhooks.ts';
import { EventDeliveriesSchema } from '@/shared/contracts/workbench-read.ts';
import { ApiError } from '../../lib/errors.ts';
import type { ToolApi } from '../../lib/tool-api.tsx';

const EVENTS = '/api/v1/events';
const ENDPOINTS = '/api/v1/webhook-endpoints';
const at = (id: string) => encodeURIComponent(id);

/** What narrows the event list: the type, the API request that caused it, the pass it is about. */
export interface FeedFilter {
  type?: string | undefined;
  request?: string | undefined;
  pass?: string | undefined;
}

/**
 * The Events tool's reads and writes, on the host's client. In the Workbench that is the Test token,
 * so every call here is Test only by construction; nothing in this file names a mode.
 */
export function eventsApi(api: ToolApi, orgId: string) {
  return {
    /** The ledger, oldest first: `after` is the last page's cursor, `now` the head. */
    feed: (after: string | undefined, f: FeedFilter) =>
      api.get(EVENTS, EventFeedPageSchema, {
        query: {
          orgId,
          after,
          limit: 200,
          types: f.type,
          requestId: f.request,
          passId: f.pass,
        },
      }),
    event: (id: string) => api.get(`${EVENTS}/${at(id)}`, WebhookEventSchema, { query: { orgId } }),
    eventDeliveries: (id: string) =>
      api.get(`${EVENTS}/${at(id)}/deliveries`, EventDeliveriesSchema, { query: { orgId } }),
    endpoints: () => api.get(ENDPOINTS, WebhookEndpointListSchema, { query: { orgId } }),
    endpoint: (id: string) => api.get(`${ENDPOINTS}/${at(id)}`, WebhookEndpointSchema),
    /** The sandbox's capture endpoint, made when it has none. */
    ensureCapture: () => api.post(`${ENDPOINTS}/capture`, CaptureEndpointCreatedSchema, {}),
    update: (id: string, patch: { status: 'active' | 'paused' }) =>
      api.patch(`${ENDPOINTS}/${at(id)}`, WebhookEndpointSchema, patch),
    remove: (id: string) => api.delete(`${ENDPOINTS}/${at(id)}`),
    sendTest: (id: string, type: string) =>
      api.post(`${ENDPOINTS}/${at(id)}/test`, WebhookTestResultSchema, { type }),
    rotate: (id: string, overlapHours: OverlapHours) =>
      api.post(`${ENDPOINTS}/${at(id)}/secret`, WebhookSecretSchema, { overlapHours }),
    captures: (id: string) =>
      api.get(`${ENDPOINTS}/${at(id)}/captures`, WebhookCaptureListSchema, {
        query: { limit: 100 },
      }),
    capture: (id: string, captureId: string) =>
      api.get(`${ENDPOINTS}/${at(id)}/captures/${at(captureId)}`, WebhookCaptureSchema),
    replayCapture: (id: string, captureId: string) =>
      api.post(
        `${ENDPOINTS}/${at(id)}/captures/${at(captureId)}/replay`,
        CaptureReplayResultSchema,
      ),
    captureSecret: async (id: string) =>
      (await api.post(`${ENDPOINTS}/${at(id)}/captures/secret`, CaptureSecretSchema)).secret,
    tests: (id: string) => api.get(`${ENDPOINTS}/${at(id)}/tests`, WebhookTestAttemptListSchema),
  };
}
export type EventsApi = ReturnType<typeof eventsApi>;

/** The sign-in URL when the server asked for a recent sign-in (possibly empty), else null. */
export function stepUpOf(e: unknown): string | null {
  return e instanceof ApiError &&
    (e.code === 'STEP_UP_REQUIRED' || e.code === 'IDP_SIGN_IN_REQUIRED')
    ? (e.signInUrl ?? '')
    : null;
}
