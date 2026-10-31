import { z } from 'zod';
import { ApiScopeSchema, IdSchema, TimestampSchema } from './common.ts';

export const ApiKeySchema = z.object({
  id: IdSchema,
  orgId: IdSchema.nullable(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(ApiScopeSchema),
  createdBy: IdSchema.nullable(),
  createdAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
});
export const ApiKeyListSchema = z.object({ items: z.array(ApiKeySchema) });
export const CreateApiKeySchema = z.object({
  orgId: IdSchema.nullable().optional(),
  name: z.string().min(1).max(120),
  scopes: z.array(ApiScopeSchema).min(1),
  expiresAt: TimestampSchema.nullable().optional(),
});
/** `secret` (wlt_<prefix>_<secret>) is returned once. */
export const CreatedApiKeySchema = ApiKeySchema.extend({ secret: z.string() });
