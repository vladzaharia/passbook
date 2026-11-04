import { z } from 'zod';
import { IdSchema, OrgIdSchema, PageQuerySchema, pageOf, TimestampSchema } from './common.ts';

/** One email held back in test mode. `to` is who it would have gone to. */
export const CapturedEmailSchema = z.object({
  id: IdSchema,
  orgId: OrgIdSchema,
  kind: z.enum(['pass', 'bundle']),
  passId: IdSchema.nullable(),
  bundleId: IdSchema.nullable(),
  to: z.string(),
  subject: z.string(),
  attached: z.boolean(),
  createdAt: TimestampSchema,
});

export const CapturedEmailDetailSchema = CapturedEmailSchema.extend({
  html: z.string(),
  text: z.string(),
});

export const CapturedEmailListQuerySchema = PageQuerySchema.extend({
  orgId: OrgIdSchema.optional(),
});
export const CapturedEmailListSchema = pageOf(CapturedEmailSchema);

/** The address the message went to: the signed-in admin's own. */
export const SentToMeSchema = z.object({ to: z.string() });
