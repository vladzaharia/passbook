import { z } from 'zod';
import { IdSchema, ModeSchema, PlainLineSchema, pageOf, TimestampSchema } from './common.ts';
import {
  SubscribableEventTypeSchema,
  WEBHOOK_MAX_TEMPLATES,
  WebhookApiVersionSchema,
  WebhookEventSchema,
  WebhookEventTypeSchema,
} from './webhooks-events.ts';

/** Endpoints per org and mode: the platform ceiling the database trigger enforces; a plan's `webhooks.endpoints` is the usual cap. */
export const WEBHOOK_ENDPOINT_LIMIT = 100;

export const WebhookEndpointStatusSchema = z.enum(['active', 'paused', 'disabled']);
export type WebhookEndpointStatus = z.infer<typeof WebhookEndpointStatusSchema>;

export const WebhookEndpointSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  mode: ModeSchema,
  /** The full URL is a capability: null for a reader (`integrations:read`). */
  url: z.string().nullable(),
  /** The host, then `/…` when there is a path: the path is a bearer secret. */
  urlMasked: z.string(),
  description: z.string(),
  eventTypes: z.array(SubscribableEventTypeSchema),
  templateIds: z.array(IdSchema).nullable(),
  apiVersion: WebhookApiVersionSchema,
  status: WebhookEndpointStatusSchema,
  /** `capture` stores the signed request instead of sending it (developer orgs, Test). */
  target: z.enum(['url', 'capture']),
  failingSince: TimestampSchema.nullable(),
  disabledAt: TimestampSchema.nullable(),
  lastSuccessAt: TimestampSchema.nullable(),
  lastFailureAt: TimestampSchema.nullable(),
  /** HTTP status of the newest attempted delivery; null when none yet or no response. */
  lastStatus: z.number().int().nullable(),
  /** The signing secret itself is never returned after creation or rotation. */
  secretCreatedAt: TimestampSchema.nullable(),
  /** A rotated secret that still signs until this time; null when none was rotated. */
  previousSecretExpiresAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type WebhookEndpointDto = z.infer<typeof WebhookEndpointSchema>;

const EventTypeList = z.array(SubscribableEventTypeSchema).min(1).max(32);
const TemplateIdList = z.array(IdSchema).min(1).max(WEBHOOK_MAX_TEMPLATES);

/** The mode is never in the body: it comes from the caller's authority. */
export const CreateWebhookEndpointSchema = z.object({
  /** A platform key names the org it acts on. */
  orgId: IdSchema.optional(),
  url: z.string().trim().min(1).max(2048),
  description: PlainLineSchema(120).optional(),
  eventTypes: EventTypeList,
  templateIds: TemplateIdList.nullable().optional(),
});

export const UpdateWebhookEndpointSchema = z.object({
  url: z.string().trim().min(1).max(2048).optional(),
  /** An empty string clears it. */
  description: z.union([z.literal(''), PlainLineSchema(120)]).optional(),
  eventTypes: EventTypeList.optional(),
  templateIds: TemplateIdList.nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
  apiVersion: WebhookApiVersionSchema.optional(),
});

/** Sent on every request; the delivery sheet shows it. */
export const WEBHOOK_USER_AGENT = 'PassBook-Webhooks/1.0';

export const WebhookSecretSchema = z.object({ secret: z.string() });
export const WebhookEndpointListSchema = pageOf(WebhookEndpointSchema);
export const WebhookEndpointCreatedSchema = z.object({
  endpoint: WebhookEndpointSchema,
  secret: z.string(),
});

export const WebhookTestResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  /** The stored capture, for a capture endpoint. */
  captureId: IdSchema.nullable(),
});

export const WebhookDeliveryStateSchema = z.enum(['pending', 'delivered', 'failed', 'cancelled']);
export const WebhookDeliverySchema = z.object({
  eventId: IdSchema,
  type: WebhookEventTypeSchema,
  passId: IdSchema,
  externalId: z.string().nullable(),
  state: WebhookDeliveryStateSchema,
  attempts: z.number().int().nonnegative(),
  nextAt: TimestampSchema,
  lastStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastAttemptAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  replays: z.number().int().nonnegative(),
});
export const WebhookDeliveryListSchema = pageOf(WebhookDeliverySchema);

export const WebhookAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  trigger: z.enum(['event', 'retry', 'replay', 'test']),
  status: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  at: TimestampSchema,
});
export const WebhookDeliveryDetailSchema = WebhookDeliverySchema.extend({
  attemptLog: z.array(WebhookAttemptSchema),
  payload: WebhookEventSchema,
});

export { WebhookReplayResultSchema, WebhookReplaySchema } from './webhooks-replay.ts';

/** `ev2.<22 chars>` (opaque), the older `ev1.<n>` (accepted for one more release), or `now` for the head. */
export const EVENT_FEED_CURSOR = /^(?:now|ev1\.(?:0|[1-9]\d{0,14})|ev2\.[A-Za-z0-9_-]{22})$/;

export const EventFeedQuerySchema = z.object({
  orgId: IdSchema.optional(),
  after: z.string().regex(EVENT_FEED_CURSOR).optional(),
  types: z
    .string()
    .max(600)
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(SubscribableEventTypeSchema).min(1).max(32))
    .optional(),
  passId: IdSchema.optional(),
  requestId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Only events a call with this `x-request-id` caused.'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  order: z
    .enum(['asc', 'desc'])
    .default('asc')
    .describe(
      "`desc` reads the newest events first, in one page, and refuses `after`. Its `nextCursor` is the newest event's: pass it as `after` to read what comes next.",
    ),
  apiVersion: WebhookApiVersionSchema.optional(),
});
export const EventFeedPageSchema = z.object({
  items: z.array(WebhookEventSchema),
  /** Never null: the last item's cursor, or the input cursor on an empty page. */
  nextCursor: z.string(),
  hasMore: z.boolean(),
});
