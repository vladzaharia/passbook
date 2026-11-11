import { z } from 'zod';
import {
  IdSchema,
  ModeSchema,
  OrgIdSchema,
  PageQuerySchema,
  pageOf,
  TimestampSchema,
} from './common.ts';

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
  forwarding: z.enum(['none', 'sending', 'sent', 'failed', 'unknown']),
});

/** A selected organization is mandatory; the inbox is never a platform-wide feed. */
export const CapturedEmailScopeQuerySchema = z.object({ orgId: OrgIdSchema });
/** Detail may declare mode explicitly, or use the console's mode header. */
export const CapturedEmailDetailQuerySchema = CapturedEmailScopeQuerySchema.extend({
  mode: ModeSchema.optional(),
});
export const CapturedEmailListQuerySchema = PageQuerySchema.extend({
  orgId: OrgIdSchema,
});
/** The iframe cannot send the console mode header, so it declares its Test mode explicitly. */
export const CapturedEmailFrameQuerySchema = CapturedEmailScopeQuerySchema.extend({
  mode: ModeSchema,
});
export const CapturedEmailListSchema = pageOf(CapturedEmailSchema);

/** The address the message went to: the signed-in member's own. */
export const SentToMeSchema = z.object({ to: z.string() });
