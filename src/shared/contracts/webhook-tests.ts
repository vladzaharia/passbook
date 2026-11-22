import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import { WebhookEventTypeSchema } from './webhooks.ts';

/** A "Send test" attempt: no feed event, so it is listed beside the deliveries, not in them. Kept 7 days. */
export const WebhookTestAttemptSchema = z.object({
  id: IdSchema,
  /** The sample event sent; `webhook.test` for the plain test. */
  type: WebhookEventTypeSchema,
  ok: z.boolean(),
  status: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  at: TimestampSchema,
});
export const WebhookTestAttemptListSchema = z.object({ items: z.array(WebhookTestAttemptSchema) });
