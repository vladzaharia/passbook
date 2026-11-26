import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import { IdpRoleSchema } from './idp-ops.ts';
import { OperationSchema } from './operations.ts';

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

const OrgRefSchema = z.object({ id: IdSchema, name: z.string() });
const AccessOrgSchema = z.object({ org: OrgRefSchema });

/** One role as the Access card shows it. `present` is what the last read of Polaris ID showed, null before any. */
export const RoleAccessSchema = z.object({
  role: IdpRoleSchema,
  wanted: z.boolean(),
  present: z.boolean().nullable(),
  /** `passbook`: PassBook added it. `external`: found in Polaris ID without a PassBook grant. */
  presence: z.enum(['none', 'passbook', 'external']),
  /** The Polaris ID owner took a role PassBook added: paused until a platform admin restores it. */
  held: z.boolean(),
  memberships: z.array(AccessOrgSchema),
  sponsorships: z.array(AccessOrgSchema),
  /** The live platform grant (developer, support), if any. */
  grantedAt: TimestampSchema.nullable(),
  /** The last apply failed with this code. */
  error: z.string().nullable(),
});

export const AccessViewSchema = z.object({
  userId: IdSchema,
  /** False while the Polaris ID binding is absent: the card stays hidden. */
  connected: z.boolean(),
  platformAdmin: z.boolean(),
  disabled: z.boolean(),
  /** The user has a Polaris ID account linked. */
  linked: z.boolean(),
  /** From Polaris ID; null when not asked or not reachable. */
  account: z.object({
    class: z.enum(['created', 'linked', 'external']).nullable(),
    disabledInIdp: z.boolean().nullable(),
  }),
  roles: z.array(RoleAccessSchema),
});
export type AccessView = z.infer<typeof AccessViewSchema>;

/** `grant: false` revokes. Console follows memberships and is never granted here. */
export const GrantRoleSchema = z.strictObject({
  role: z.enum(['developer', 'support']),
  grant: z.boolean(),
});
export type GrantRole = z.infer<typeof GrantRoleSchema>;

export const ExternalRoleParamSchema = z.object({ id: IdSchema, role: IdpRoleSchema });

export const OffboardSchema = z.strictObject({ dryRun: z.boolean().default(false) });

const PlanOrgSchema = z.object({ org: OrgRefSchema });

/** What offboarding ends. A dry run returns it and changes nothing; the real run ends exactly these. */
export const OffboardPlanSchema = z.object({
  userId: IdSchema,
  memberships: z.array(PlanOrgSchema.extend({ membershipId: IdSchema })),
  /** Memberships left in place because their org is not active: nothing of theirs works while the user is disabled. */
  kept: z.array(PlanOrgSchema),
  sponsorships: z.array(PlanOrgSchema),
  grants: z.array(z.enum(['developer', 'support'])),
  /** Personal keys of the revoked memberships stop with them; platform keys the user made are revoked. */
  personalKeys: z.number().int().min(0),
  platformKeys: z.array(IdSchema),
  sessions: z.number().int().min(0),
  sandboxOrgId: IdSchema.nullable(),
  /** Roles PassBook removes in Polaris ID. */
  removes: z.array(IdpRoleSchema),
  /** Roles added in Polaris ID that PassBook leaves: **Remove anyway** can take them. */
  external: z.array(IdpRoleSchema),
  /** Why the offboard cannot start: an org that would lose its last admin. */
  blockers: z.array(PlanOrgSchema.extend({ code: z.literal('LAST_ORG_ADMIN') })),
});
export type OffboardPlan = z.infer<typeof OffboardPlanSchema>;

/** A dry run answers 200 with the plan and no operation; the real run answers 202 with both. */
export const OffboardStartedSchema = z.object({
  plan: OffboardPlanSchema,
  operation: OperationSchema.nullable(),
});

export const IdpStatusSchema = z.object({
  connected: z.boolean(),
  mode: z.enum(['dry_run', 'live']).nullable(),
  frozen: z.boolean().nullable(),
  keyExpiresAt: TimestampSchema.nullable(),
  /** Warnings and unsafe settings the binding found, by code. */
  problems: z.array(z.string()),
  budget: z.record(z.string(), z.object({ day: z.number(), limit: z.number() })),
  lastScimAt: TimestampSchema.nullable(),
  drift: z.record(z.string(), z.number().int()),
  breakerOpen: z.boolean(),
});

export const DriftItemSchema = z.object({
  id: IdSchema,
  userId: IdSchema.nullable(),
  target: z.string(),
  kind: z.string(),
  foundAt: TimestampSchema,
});
export const DriftListSchema = z.object({ items: z.array(DriftItemSchema), nextCursor: z.null() });

export const FreezeSchema = z.strictObject({ reason: z.string().trim().min(3).max(200) });
export const FrozenSchema = z.object({ result: z.enum(['frozen', 'already']) });

export const IdpCallsQuerySchema = z.object({
  since: z.coerce.number().int().min(0),
  cursor: z
    .string()
    .regex(/^\d{1,12}$/)
    .optional(),
});
export const IdpCallSchema = z.object({
  id: z.number().int(),
  phase: z.string(),
  method: z.string(),
  target: z.string().nullable(),
  actor: z.string().nullable(),
  reason: z.string().nullable(),
  status: z.string().nullable(),
  at: TimestampSchema,
});
export const IdpCallListSchema = z.object({
  items: z.array(IdpCallSchema),
  nextCursor: z.string().nullable(),
});
