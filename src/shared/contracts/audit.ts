import { z } from 'zod';
import { IdSchema, JsonSchema, pageOf, TimestampSchema } from './common.ts';

export const AuditEntrySchema = z.object({
  id: z.number().int(),
  at: TimestampSchema,
  orgId: IdSchema.nullable(),
  actorType: z.enum(['user', 'api_key', 'system', 'connection', 'device']),
  actorId: z.string().nullable(),
  /** Display name for the actor (user name or email, key name); null when unknown or deleted. */
  actorLabel: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  /** Display name for the target (pass title, org or template name); null when unknown or deleted. */
  targetLabel: z.string().nullable(),
  requestId: z.string().nullable(),
  detail: JsonSchema.nullable(),
});
export const AuditQuerySchema = z.object({
  orgId: IdSchema.optional(),
  actorId: z.string().optional(),
  action: z.string().max(100).optional(),
  targetType: z.string().max(50).optional(),
  targetId: z.string().max(100).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const AuditListSchema = pageOf(AuditEntrySchema);
