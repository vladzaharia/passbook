import { z } from 'zod';
import {
  ApiScopeSchema,
  IdSchema,
  ModeSchema,
  PageQuerySchema,
  pageOf,
  TimestampSchema,
} from './common.ts';
import { OrgRoleSchema } from './org-membership.ts';
import { PassStyleSchema } from './templates.ts';

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
  'brand:manage',
  'scanning:write',
] as const satisfies readonly z.infer<typeof ApiScopeSchema>[];
export const MintableScopeSchema = z.enum(MINTABLE_SCOPES);

/** `service` belongs to an org, `personal` to one member of it, `platform` to the operator (no org). */
export const ApiKeyKindSchema = z.enum(['service', 'personal', 'platform']);
export const API_KEY_RATE_TIERS = ['standard', 'high', 'bulk'] as const;

export const ApiKeySchema = z.object({
  id: IdSchema,
  orgId: IdSchema.nullable(),
  name: z.string(),
  prefix: z.string(),
  /** What the secret starts with, up to the end of `prefix`: `pb_live_<prefix>`, or `wlt_<prefix>` for an older key. */
  secretPrefix: z.string().optional(),
  scopes: z.array(ApiScopeSchema),
  mode: ModeSchema.default('live'),
  createdBy: IdSchema.nullable(),
  /** The creator's name or email, for the actor chip. */
  createdByName: z.string().nullable().default(null),
  createdAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  kind: ApiKeyKindSchema.default('service'),
  /** Role presets; the key also holds each role's scopes, read at every request. */
  roles: z.array(OrgRoleSchema).default([]),
  /** The key stops working at this instant (set once, never after `expiresAt`). */
  retireAt: TimestampSchema.nullable().default(null),
  /** CIDRs the caller's address must match; empty means any address. */
  ipAllow: z.array(z.string()).default([]),
  /** Templates and pass styles the key is limited to; both empty means unrestricted. */
  templateIds: z.array(IdSchema).default([]),
  passStyles: z.array(PassStyleSchema).default([]),
  /** Null follows the deployment default. */
  rateTier: z.enum(API_KEY_RATE_TIERS).nullable().default(null),
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
  /** Omitted: `platform` without an org, else `service`. A `personal` key acts for the creating member. */
  kind: ApiKeyKindSchema.optional(),
  scopes: z.array(MintableScopeSchema).default([]),
  /** Role presets in place of, or beside, `scopes`; at least one of the two is required. */
  roles: z.array(OrgRoleSchema).max(OrgRoleSchema.options.length).default([]),
  ipAllow: z.array(z.string().min(1).max(60)).max(20).optional(),
  /** Limit the key to these templates and pass styles (org keys only). */
  templateIds: z.array(IdSchema).max(20).optional(),
  passStyles: z.array(PassStyleSchema).max(10).optional(),
  /** The terminals a `scans:write` key acts as, fixed for the key's life: at least one with that scope, none without. */
  terminalIds: z.array(IdSchema).max(20).optional(),
  mode: ModeSchema.default('live'),
  expiresAt: TimestampSchema.nullable().optional(),
});
/** `secret` (`pb_live_<prefix>_<secret>`, `pbp_` personal, `pbo_` platform) is returned once. */
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
  kind: true,
  roles: true,
  retireAt: true,
});
/** Retire a key at an instant before it would otherwise end; set once. */
export const RetireApiKeySchema = z.object({
  orgId: IdSchema.nullable(),
  retireAt: TimestampSchema,
});
