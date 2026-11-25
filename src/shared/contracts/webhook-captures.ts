import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';
import {
  RequestIdFilterSchema,
  SubscribableEventTypeSchema,
  WebhookEndpointSchema,
  WebhookEventTypeSchema,
} from './webhooks.ts';

/** What a capture endpoint keeps. Counts are per endpoint and per org; bytes per capture. */
export const WEBHOOK_CAPTURE_LIMITS = {
  perEndpoint: 200,
  perHour: 600,
  maxBytes: 256 * 1024,
  retentionDays: 7,
} as const;

/** `url` sends; `capture` stores the signed request in the developer org and sends nothing. */
export const WebhookTargetSchema = z.enum(['url', 'capture']);
export type WebhookTarget = z.infer<typeof WebhookTargetSchema>;

export const WebhookCaptureTriggerSchema = z.enum(['event', 'replay', 'test']);

export const WebhookCaptureSchema = z.object({
  id: IdSchema,
  endpointId: IdSchema,
  eventId: IdSchema,
  type: WebhookEventTypeSchema,
  trigger: WebhookCaptureTriggerSchema,
  status: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  /** Exactly what was signed and would have been sent. */
  headers: z.record(z.string(), z.string()),
  /** The raw request body: verify the signature over these bytes. */
  body: z.string(),
  createdAt: TimestampSchema,
});
export type WebhookCaptureDto = z.infer<typeof WebhookCaptureSchema>;

export const WebhookCaptureListSchema = pageOf(WebhookCaptureSchema);
export const WebhookCaptureListQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^\d{1,15}\.[A-Za-z0-9-]{1,64}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  type: WebhookEventTypeSchema.optional(),
  /** Only captures of events caused by this API request (`x-request-id`). */
  requestId: RequestIdFilterSchema.optional(),
  /** Only captures of events of this pass. */
  passId: IdSchema.optional(),
});

export const WebhookCaptureParamSchema = z.object({ id: IdSchema, captureId: IdSchema });

/** The event to send. Any type; `webhook.test` when omitted. */
export const SendTestEventSchema = z.object({
  type: WebhookEventTypeSchema.default('webhook.test'),
});

export const CreateCaptureEndpointSchema = z.object({
  /** A platform key names the org it acts on. */
  orgId: IdSchema.optional(),
  eventTypes: z.array(SubscribableEventTypeSchema).min(1).max(32).optional(),
});
/** `secret` is set only when the endpoint was just made; an existing one answers 200 with null. */
export const CaptureEndpointCreatedSchema = z.object({
  endpoint: WebhookEndpointSchema,
  secret: z.string().nullable(),
});
export const CaptureSecretSchema = z.object({ secret: z.string() });
export const CaptureReplayResultSchema = z.object({ capture: WebhookCaptureSchema });
