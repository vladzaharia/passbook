import { z } from 'zod';

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
