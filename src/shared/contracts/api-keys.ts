import { z } from 'zod';
import {
  ApiScopeSchema,
  IdSchema,
  ModeSchema,
  PageQuerySchema,
  pageOf,
  TimestampSchema,
} from './common.ts';

export const ApiKeySchema = z.object({
  id: IdSchema,
  orgId: IdSchema.nullable(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(ApiScopeSchema),
  mode: ModeSchema.default('live'),
  createdBy: IdSchema.nullable(),
  /** The creator's name or email, for the actor chip. */
  createdByName: z.string().nullable().default(null),
  createdAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
});
export const ApiKeyListQuerySchema = PageQuerySchema.extend({
  /** Keys of one org; platform keys (no org) are left out. */
  orgId: IdSchema.optional(),
  /** `live`: not revoked (expired included); `revoked`: revoked only. Both when absent. */
  state: z.enum(['live', 'revoked']).optional(),
});
/** Newest first; `cursor` is the last id of the previous page. */
export const ApiKeyListSchema = pageOf(ApiKeySchema).extend({
  /** Revoked keys under the same org filter ("Show revoked (3)"). */
  revokedCount: z.number().int().nonnegative().default(0),
});
export const CreateApiKeySchema = z.object({
  orgId: IdSchema.nullable().optional(),
  name: z.string().min(1).max(120),
  scopes: z.array(ApiScopeSchema).min(1),
  mode: ModeSchema.default('live'),
  expiresAt: TimestampSchema.nullable().optional(),
});
/** `secret` (wlt_<prefix>_<secret>) is returned once. */
export const CreatedApiKeySchema = ApiKeySchema.extend({ secret: z.string() });
