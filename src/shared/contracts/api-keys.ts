import { z } from 'zod';
import {
  ApiScopeSchema,
  IdSchema,
  ModeSchema,
  PageQuerySchema,
  pageOf,
  TimestampSchema,
} from './common.ts';

/**
 * The scopes a key may be minted with: those some route accepts today. A scope joins this list in
 * the change that makes a route accept it, so no key holds authority nobody reviewed.
 */
export const MINTABLE_SCOPES = [
  'passes:read',
  'passes:write',
  'holders:write',
  'templates:read',
  'messages:write',
  'scans:read',
  'scans:write',
  'connections:read',
  'connections:write',
  'webhooks:manage',
] as const satisfies readonly z.infer<typeof ApiScopeSchema>[];
export const MintableScopeSchema = z.enum(MINTABLE_SCOPES);

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
/** The literal query value `null` selects platform-wide keys. */
export const ApiKeyScopeQuerySchema = z.object({
  orgId: z.union([z.literal('null').transform(() => null), IdSchema]),
});
export const ApiKeyListQuerySchema = PageQuerySchema.extend({
  /** An exact organization ID, or `null` for platform-wide keys. */
  orgId: ApiKeyScopeQuerySchema.shape.orgId,
  /** `live`: not revoked (expired included); `revoked`: revoked only. Both when absent. */
  state: z.enum(['live', 'revoked']).optional(),
});
/** Newest first; `cursor` is the last id of the previous page. */
export const ApiKeyListSchema = pageOf(ApiKeySchema).extend({
  /** Revoked keys under the same org filter ("Show revoked (3)"). */
  revokedCount: z.number().int().nonnegative().default(0),
});
export const CreateApiKeySchema = z.object({
  orgId: IdSchema.nullable(),
  name: z.string().min(1).max(120),
  scopes: z.array(MintableScopeSchema).min(1),
  /** The terminals a `scans:write` key acts as, fixed for the key's life: at least one with that scope, none without. */
  terminalIds: z.array(IdSchema).max(20).optional(),
  mode: ModeSchema.default('live'),
  expiresAt: TimestampSchema.nullable().optional(),
});
/** `secret` (wlt_<prefix>_<secret>) is returned once. */
export const CreatedApiKeySchema = ApiKeySchema.extend({ secret: z.string() });
/** What a key may read about itself: never the secret or its hash. */
export const ApiKeyMeSchema = ApiKeySchema.pick({
  id: true,
  orgId: true,
  name: true,
  prefix: true,
  scopes: true,
  mode: true,
  createdAt: true,
  lastUsedAt: true,
  expiresAt: true,
});
