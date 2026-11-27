import { z } from 'zod';
import { TimestampSchema } from './common.ts';

export const WebhookReplaySchema = z
  .object({
    from: TimestampSchema,
    to: TimestampSchema,
    include: z.enum(['failed', 'failed_and_cancelled', 'all']).default('failed'),
    /** Also create deliveries for feed events the endpoint never had. */
    missing: z.boolean().optional(),
    /** Count what would be sent and change nothing. */
    dryRun: z.boolean().optional(),
  })
  .refine((r) => r.from <= r.to, { message: 'from must not be after to', path: ['from'] });
export const WebhookReplayResultSchema = z.object({ queued: z.number().int().nonnegative() });
