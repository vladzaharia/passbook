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
 * The scopes of a Platform key, the only flavour that reaches `platform` routes. A key holds these alone (no org
 * scope, `API_KEY_PLATFORM_SCOPES_ALONE`), and only a `platform` kind key holds them (`API_KEY_PLATFORM_SCOPE_KIND`).
 */
export const PLATFORM_KEY_SCOPES = [
  'platform:read',
  'platform:orgs',
  'platform:users',
  'platform:groups',
  'platform:claims',
  'platform:identities',
  'platform:wallet',
  'platform:settings',
  'platform:status',
  'platform:templates',
  'platform:audit',
] as const satisfies readonly z.infer<typeof ApiScopeSchema>[];

/**
 * The scopes a key may be minted with: those some route accepts today. A scope joins this list in
 * the change that makes a route accept it, so no key holds authority nobody reviewed.
 */
export const MINTABLE_SCOPES = [
  'passes:read',
  'passes:write',
  'holders:write',
  'templates:read',
  'templates:write',
  'templates:review',
  'templates:publish',
  'messages:write',
  'scans:read',
  'scans:write',
  'connections:read',
  'connections:write',
  'webhooks:manage',
  'brand:manage',
  'org:read',
  'org:write',
  'wallet:write',
  'scanning:write',
  'scan-setup:read',
  'scanning:admin',
  'nfc:keys',
  'nfc:read',
  'nfc:write',
  'api-keys:write',
  'audit:read',
  'members:read',
  'members:write',
  ...PLATFORM_KEY_SCOPES,
] as const satisfies readonly z.infer<typeof ApiScopeSchema>[];
/** Scopes that mint or reset device credentials, or invite people into developer access: named in `scopes` only, never through a role or a parent key, live and one org. */
export const CREDENTIAL_SCOPES = [
  'scanning:admin',
  'nfc:keys',
  'members:write',
] as const satisfies readonly (typeof MINTABLE_SCOPES)[number][];
/** Review and release run in Test only (a Live key may only request review): a Live key never holds these, named or through a role. */
export const TEST_ONLY_SCOPES = [
  'templates:review',
  'templates:publish',
] as const satisfies readonly (typeof MINTABLE_SCOPES)[number][];
/** Template scopes act as the key's creator: a key with no human creator (a platform key, a child) never holds them. */
export const TEMPLATE_ACT_AS_SCOPES = [
  'templates:write',
  'templates:review',
  'templates:publish',
] as const satisfies readonly (typeof MINTABLE_SCOPES)[number][];
/**
 * Whether a key of this mode may hold `audit:read`: the log has no mode, so only a Live key, or a key of a developer
 * sandbox (which is Test only). One rule for the mint check and the key dialog.
 */
export const auditScopeAllowed = (mode: 'live' | 'test', developerOrg: boolean): boolean =>
  mode === 'live' || developerOrg;
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
  /** Role labels. A role's scopes were written into `scopes` at mint and never change. */
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
  /** The key that minted this one as its child; the child ends with it. */
  parentKeyId: IdSchema.nullable().default(null),
  /** The key this one replaced when it was rotated. */
  rotatedFrom: IdSchema.nullable().default(null),
});
/** The literal query value `null` selects platform-wide keys; an org key leaves `orgId` out. */
export const ApiKeyScopeQuerySchema = z.object({
  orgId: z.union([z.literal('null').transform(() => null), IdSchema]).optional(),
});
export const ApiKeyListQuerySchema = PageQuerySchema.extend({
  /** An exact organization ID, or `null` for platform-wide keys. */
  orgId: ApiKeyScopeQuerySchema.shape.orgId,
  /** `live`: not revoked (expired included); `revoked`: revoked only. Both when absent. */
  state: z.enum(['live', 'revoked']).optional(),
  /** Only the children of this key. */
  parentKeyId: IdSchema.optional(),
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

/** What a retire answers. Its own schema so the SDK names it. */
export const RetiredApiKeySchema = z.object({ ok: z.literal(true) });

/** A key with its family and last use: what the key page shows. */
export const ApiKeyDetailSchema = ApiKeySchema.extend({
  /** The first part of the address of the last call: a network, never a full address. */
  lastIpPrefix: z.string().nullable(),
  parent: z.object({ id: IdSchema, name: z.string() }).nullable(),
  /** The key that replaced this one, once rotated. */
  replacedBy: z.object({ id: IdSchema, name: z.string() }).nullable(),
  childCount: z.number().int().nonnegative(),
});
/** Replace a key: the new secret works at once; the old key stops after the overlap. */
export const RotateApiKeySchema = z.object({
  orgId: IdSchema.nullable(),
  /** Hours the old key keeps working beside the new one; 0 retires it at once. */
  overlapHours: z.number().int().min(0).max(168).default(24),
});
/** What a call with an `Idempotency-Key` returns when it replays: the key, never its secret again. */
export const ReplayedApiKeySchema = ApiKeySchema;
/** The mint's answer: `secret` is absent on a replay. One object, so the 201 keeps the fields clients already read. */
export const MintedApiKeySchema = ApiKeySchema.extend({ secret: z.string().optional() });
export const RotatedApiKeySchema = z.object({
  key: z.union([CreatedApiKeySchema, ReplayedApiKeySchema]),
  previous: ApiKeySchema,
});
export const ApiKeyActivityQuerySchema = z.object({
  orgId: ApiKeyScopeQuerySchema.shape.orgId,
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
/** What a key did lately, from the audit log: never a request body or a secret. */
export const ApiKeyActivitySchema = z.object({
  lastUsedAt: TimestampSchema.nullable(),
  lastIpPrefix: z.string().nullable(),
  summary: z.object({
    since: TimestampSchema,
    calls: z.number().int().nonnegative(),
    denied: z.number().int().nonnegative(),
    actions: z.array(
      z.object({ action: z.string(), count: z.number().int(), lastAt: TimestampSchema }),
    ),
  }),
  recent: z.array(
    z.object({
      id: z.number().int(),
      at: TimestampSchema,
      action: z.string(),
      outcome: z.enum(['allowed', 'denied']),
      targetType: z.string().nullable(),
      targetId: z.string().nullable(),
      ipPrefix: z.string().nullable(),
      /** The refusal code, for a denied call. */
      code: z.string().nullable(),
    }),
  ),
});
