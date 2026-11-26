import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';
import { OrgRolesSchema } from './org-membership.ts';

/** Mirrors the Polaris ID binding's limits (design 2 section 3.1); the binding enforces its own rules and key namespace. */
export const CLAIM_VALUE_MAX_BYTES = 2048;
export const CLAIM_MAX_DEPTH = 5;
export const CLAIM_MAX_CHANGES = 20;

export const ClaimTypeSchema = z.enum(['text', 'number', 'boolean', 'json']);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const ClaimKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'Use letters, digits, _ . : -.');

const depthOf = (value: unknown): number =>
  value !== null && typeof value === 'object'
    ? 1 + Math.max(0, ...Object.values(value).map(depthOf))
    : 0;

const fits = (type: ClaimType, value: unknown): boolean => {
  switch (type) {
    case 'text':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return value !== null && typeof value === 'object';
  }
};

/** Text stays a string in tokens even when it looks like a number or JSON: the type says which. */
export const ClaimValueSchema = z
  .strictObject({
    type: ClaimTypeSchema,
    value: z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.unknown()),
      z.record(z.string(), z.unknown()),
    ]),
  })
  .superRefine((claim, ctx) => {
    if (!fits(claim.type, claim.value))
      ctx.addIssue({ code: 'custom', path: ['value'], message: `Not a ${claim.type} value.` });
    else if (new TextEncoder().encode(JSON.stringify(claim.value)).length > CLAIM_VALUE_MAX_BYTES)
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Value is too long (2 KB).' });
    else if (depthOf(claim.value) > CLAIM_MAX_DEPTH)
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Value is nested too deep.' });
  });
export type ClaimValue = z.infer<typeof ClaimValueSchema>;

/** Only the claims PassBook manages. `otherKeys` counts the claims other apps or the owner set; they are never listed. */
export const ClaimsViewSchema = z.object({
  claims: z.record(z.string(), z.object({ type: ClaimTypeSchema, value: z.unknown() })),
  otherKeys: z.number().int().min(0),
});
export type ClaimsView = z.infer<typeof ClaimsViewSchema>;

/** `null` removes a key; keys not named are untouched. */
export const UpdateClaimsSchema = z.strictObject({
  set: z
    .record(ClaimKeySchema, ClaimValueSchema.nullable())
    .refine((set) => Object.keys(set).length >= 1, 'Change at least one claim.')
    .refine(
      (set) => Object.keys(set).length <= CLAIM_MAX_CHANGES,
      `Change at most ${CLAIM_MAX_CHANGES} claims at once.`,
    ),
});
export type UpdateClaims = z.infer<typeof UpdateClaimsSchema>;

export const ClaimsResultSchema = z.object({
  set: z.array(z.string()),
  removed: z.array(z.string()),
  /** True while Polaris ID changes are in dry run: nothing was sent. */
  dryRun: z.boolean(),
});
export type ClaimsResult = z.infer<typeof ClaimsResultSchema>;

/** A role (`console`, `developer`, `support`) or a custom or adopted group key. */
export const GroupKeyParamSchema = z.object({ key: z.string().regex(/^[a-z0-9_]{1,64}$/) });

/** Custom groups: `passbook_g_<key>` in Polaris ID. The key never changes and is never reused. */
export const GROUP_RESERVED_KEYS = ['console', 'developer', 'support', 'platform_admin', 'users'];
export const GroupNewKeySchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,39}$/,
    'Use 2-40 lowercase letters, digits or _, starting with a letter.',
  )
  .refine((key) => !GROUP_RESERVED_KEYS.includes(key), 'This key is reserved.');
export const GroupFriendlyNameSchema = z.string().trim().min(2).max(50);
export const WritableRoleSchema = z.enum(['console', 'developer', 'support']);

export const GroupKindSchema = z.enum(['role', 'custom', 'adopted']);
export const GroupSchema = z.object({
  key: z.string(),
  kind: GroupKindSchema,
  /** The name in every app's `groups` claim. */
  name: z.string(),
  friendlyName: z.string().nullable(),
  /** Members in Polaris ID; null when it could not be read. */
  members: z.number().int().min(0).nullable(),
  /** Managed claim keys set on the group, no values. */
  claims: z.array(z.string()),
  /** Apps other than PassBook that allow the group. */
  otherClients: z.number().int().min(0).nullable(),
  /** Why writes to the group are blocked, such as `group_name_mismatch`. */
  flags: z.array(z.string()),
  /** Live PassBook sources: org rules and manual members. */
  rules: z.number().int().min(0),
  manual: z.number().int().min(0),
});
export type Group = z.infer<typeof GroupSchema>;
export const GroupListSchema = pageOf(GroupSchema);

export const GroupRuleInputSchema = z.strictObject({
  orgId: IdSchema,
  /** Only members with one of these org roles; any role when left out. */
  orgRoles: OrgRolesSchema.optional(),
});
export type GroupRuleInput = z.infer<typeof GroupRuleInputSchema>;
export const CreateGroupSchema = z.strictObject({
  key: GroupNewKeySchema,
  friendlyName: GroupFriendlyNameSchema,
  rules: z.array(GroupRuleInputSchema).max(5).optional(),
});
export type CreateGroup = z.infer<typeof CreateGroupSchema>;
export const EnsureGroupSchema = z.strictObject({ role: WritableRoleSchema });
export const UpdateGroupSchema = z.strictObject({ friendlyName: GroupFriendlyNameSchema });

export const GroupResultSchema = z.object({
  key: z.string(),
  /** True while Polaris ID changes are in dry run: nothing was sent. */
  dryRun: z.boolean(),
});
export type GroupResult = z.infer<typeof GroupResultSchema>;

export const GroupRuleSchema = z.object({
  id: IdSchema,
  orgId: IdSchema,
  orgRoles: OrgRolesSchema.nullable(),
  createdAt: TimestampSchema,
});
export type GroupRule = z.infer<typeof GroupRuleSchema>;
export const GroupRuleListSchema = pageOf(GroupRuleSchema);

export const GroupMemberSchema = z.object({
  id: IdSchema,
  /** The Polaris ID subject. */
  subject: z.string(),
  userId: IdSchema.nullable(),
  source: z.enum(['manual', 'invitation']),
  createdAt: TimestampSchema,
});
export type GroupMember = z.infer<typeof GroupMemberSchema>;
export const GroupMemberListSchema = pageOf(GroupMemberSchema);
/** A PassBook user (their one Polaris ID account) or a Polaris ID subject. */
export const CreateGroupMemberSchema = z.union([
  z.strictObject({ userId: IdSchema }),
  z.strictObject({ subject: z.string().trim().min(1).max(255) }),
]);
export type CreateGroupMember = z.infer<typeof CreateGroupMemberSchema>;

export const GroupRuleParamSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,64}$/),
  id: IdSchema,
});
