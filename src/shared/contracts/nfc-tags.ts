import { z } from 'zod';
import { IdSchema, ModeSchema, PlainLineSchema, pageOf, TimestampSchema } from './common.ts';
import { UuidV7Schema } from './scan-base.ts';

/** Tags are third-party NFC tags bound to one pass or one user. `nfc.ts` is the Wallet VAS contract. */

const NDEF_MAX_BYTES = 1024;
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/** A UID is 4, 7 or 10 bytes, as hex. */
export const TagUidSchema = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{14}|[0-9a-fA-F]{20})$/, 'A tag ID has 4, 7 or 10 bytes.');
export const TagTechSchema = z.enum(['a', 'b', 'isodep', 'unknown']);
export const TagSourceSchema = z.enum(['native', 'webnfc']);

/** One tag read from a reader. `uid` or `ndef` is required; the server never trusts `uidRandom` alone. */
export const TagReadSchema = z
  .strictObject({
    uid: TagUidSchema.optional(),
    uidRandom: z.boolean().optional(),
    tech: TagTechSchema,
    ndef: z
      .strictObject({
        type: z.enum(['U', 'T']),
        value: z
          .string()
          .min(1)
          .refine((v) => utf8Bytes(v) <= NDEF_MAX_BYTES, 'The NDEF record is over 1024 bytes.'),
      })
      .optional(),
    source: TagSourceSchema,
  })
  .refine((read) => read.uid !== undefined || read.ndef !== undefined, 'The read has no tag data.');
export type TagRead = z.infer<typeof TagReadSchema>;

export const TagAssuranceSchema = z.enum(['basic', 'secure']);
export const TagKindSchema = z.enum(['uid', 'sun']);
export const TagScopeSchema = z.enum(['pass', 'user']);
export const TagSourceKindSchema = z.enum(['scanner', 'remote', 'admin']);
export const TagStatusSchema = z.enum(['active', 'retired']);
/** What a list shows: `lent` is a pool tag on a visitor, `lost` has no binding and was reported. */
export const TagStateSchema = z.enum(['assigned', 'spare', 'lent', 'lost', 'retired']);
export const TagEndCauseSchema = z.enum([
  'admin',
  'staff',
  'undo',
  'lost',
  'replaced',
  'moved',
  'holder_changed',
  'pass_deleted',
  'no_passes',
  'offboard',
  'visitor_out',
  'pass_ended',
  'tag_retired',
]);
/** Who may assign tags on a scanner. */
export const TagAssignRoleSchema = z.enum(['desk', 'manager', 'never']);
/** A session's tag level; absent means the org's. */
export const TagLevelSchema = z.enum(['off', 'basic', 'secure']);
/** `assign` binds a tag to the scanned pass, `assignAll` to the person. */
export const ScannerTagsSettingsSchema = z.object({
  assign: TagAssignRoleSchema.default('desk'),
  assignAll: TagAssignRoleSchema.default('manager'),
});

/**
 * One of a user-bound tag's passes, for **Why this pass** / **Why not?** (Desk and up). `used`: the pass the
 * scan acted on; `lets_in`: also valid; `refused`: its reason; `unchecked`: not evaluated after a valid one;
 * `not_here`: this scanner does not take it (never named).
 */
export const ScanTagPassSchema = z.object({
  passId: IdSchema.nullable(),
  templateName: z.string().nullable(),
  state: z.enum(['used', 'lets_in', 'refused', 'unchecked', 'not_here']),
  reason: z.string().nullable(),
});
/** What a scan outcome or card says about the tag it was read from. Never on a customer screen. */
export const ScanTagSchema = z.object({
  hint: z.string().regex(/^[0-9A-F]{4}$/),
  assurance: TagAssuranceSchema,
  scope: TagScopeSchema,
  /** A user binding: how many of the holder's passes it read ("1 of {name}'s 3 passes"). */
  count: z.number().int().min(0).max(8).optional(),
  /** A user binding, Desk and up: each pass in the order it was tried. */
  passes: z.array(ScanTagPassSchema).max(8).optional(),
});
export type ScanTag = z.infer<typeof ScanTagSchema>;

export const TAG_ERROR_CODES = [
  'TAG_LOST',
  'TAG_SECURE_REQUIRED',
  'TAG_CHECK_FAILED',
  'TAG_ALREADY_ASSIGNED',
  'TAG_REQUEST_BUSY',
  'TAG_REQUEST_EXPIRED',
  'TAG_HELD_BY_OTHER',
  'TAG_NO_ACCOUNT',
  'TAG_RETIRED',
  'TAG_UID_RANDOM',
  'TAG_BINDING_LIMIT',
  'TAG_LIMIT',
  'TAG_ASSURANCE_LOW',
  'TAG_HOLDER_CHANGED',
  'SCANNER_OFFLINE',
] as const;
export const TagErrorCodeSchema = z.enum(TAG_ERROR_CODES);

export const TagBindingSchema = z.object({
  id: IdSchema,
  tagId: IdSchema,
  scope: TagScopeSchema,
  passId: IdSchema,
  passTitle: z.string().nullable(),
  userId: IdSchema.nullable(),
  /** The holder's display name, for a user binding. */
  holderName: z.string().nullable(),
  source: TagSourceKindSchema,
  /** A loaner on a visitor pass. Always pass scope; check-out ends it. */
  lent: z.boolean().default(false),
  boundAt: TimestampSchema,
  boundByName: z.string().nullable(),
  scannerName: z.string().nullable(),
  endedAt: TimestampSchema.nullable(),
  endCause: TagEndCauseSchema.nullable(),
});
export type TagBinding = z.infer<typeof TagBindingSchema>;

export const TagSchema = z.object({
  id: IdSchema,
  mode: ModeSchema,
  kind: TagKindSchema,
  assurance: TagAssuranceSchema,
  /** The last two UID bytes, 4 hex digits. The UID is never stored. */
  hint: z.string().regex(/^[0-9A-F]{4}$/),
  label: z.string().nullable(),
  pool: z.boolean(),
  status: TagStatusSchema,
  state: TagStateSchema,
  createdAt: TimestampSchema,
  lastSeenAt: TimestampSchema.nullable(),
  keysetId: IdSchema.nullable(),
  binding: TagBindingSchema.nullable(),
});
export type Tag = z.infer<typeof TagSchema>;
export const TagListQuerySchema = z.object({
  orgId: IdSchema,
  status: TagStateSchema.optional(),
  q: z.string().trim().max(80).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const TagListSchema = pageOf(TagSchema);

export const UpdateTagSchema = z.strictObject({
  label: PlainLineSchema(40).nullable().optional(),
  pool: z.boolean().optional(),
});

/** The card a tag is assigned to: a possession credential, or a lookup that needs a Manager PIN. */
const TagCardInputSchema = z.union([
  z.object({
    code: z.string().min(1).max(1024),
    method: z.enum(['camera', 'wedge', 'nfc', 'manual']),
  }),
  z.object({ passId: IdSchema, method: z.literal('manual') }),
]);
const TagApprovalSchema = z.object({
  staffId: IdSchema.optional(),
  pin: z.string().regex(/^\d{6}$/),
});

export const ScanTagInspectRequestSchema = z.strictObject({ tag: TagReadSchema });
export const ScanTagInspectResponseSchema = z.object({
  state: z.enum(['new', 'bound', 'lost', 'retired', 'not_allowed', 'invalid']),
  hint: z
    .string()
    .regex(/^[0-9A-F]{4}$/)
    .nullable(),
  assurance: TagAssuranceSchema.nullable(),
  /** For `bound`: what it opens now. */
  bound: z
    .object({ scope: TagScopeSchema, passTitle: z.string(), holderName: z.string().nullable() })
    .nullable(),
  /** For `lost`: when it was reported. */
  lostAt: TimestampSchema.nullable(),
  boundAt: TimestampSchema.nullable(),
  boundByName: z.string().nullable(),
});
export const ScanTagBindRequestSchema = z.strictObject({
  idempotencyKey: UuidV7Schema,
  tag: TagReadSchema,
  card: TagCardInputSchema,
  /** True: check and describe, write nothing. */
  preview: z.boolean().default(false),
  binding: TagScopeSchema.default('pass'),
  /** Move the tag from another holder. Needs a Manager PIN. */
  move: z.boolean().optional(),
  /** A loaner on a visitor pass; pass scope only. */
  pool: z.boolean().optional(),
  label: PlainLineSchema(40).optional(),
  approval: TagApprovalSchema.optional(),
});
export const ScanTagWarningSchema = z.enum([
  'replaces_pass_tag',
  'replaces_user_tag',
  'lost',
  'basic_too_low',
  'held_by_other',
]);
export const ScanTagBindResultSchema = z.object({
  status: z.enum(['preview', 'bound', 'already_bound', 'moved']),
  hint: z.string().regex(/^[0-9A-F]{4}$/),
  assurance: TagAssuranceSchema,
  scope: TagScopeSchema,
  bindingId: IdSchema.nullable(),
  card: z.object({
    passId: IdSchema,
    title: z.string(),
    subtitle: z.string().nullable(),
    templateName: z.string(),
    holderName: z.string().nullable(),
    photoUrl: z.string().nullable(),
  }),
  /** The pass has an owner account, so `user` scope is possible. */
  ownerAccount: z.boolean(),
  /** Titles of the person's passes a basic tag will not open. */
  skipped: z.array(z.string()).max(8),
  warnings: z.array(ScanTagWarningSchema).max(5),
  lostAt: TimestampSchema.nullable(),
  /** Undo on this device until then. */
  undoUntil: TimestampSchema.nullable(),
});

export const TagKeysetSchema = z.object({
  id: IdSchema,
  name: z.string(),
  /** The 8-character path of the tag URL, `/t/{slug}`. */
  slug: z.string().regex(/^[a-z0-9]{8}$/),
  diversify: z.boolean(),
  createdAt: TimestampSchema,
  disabledAt: TimestampSchema.nullable(),
});
const KeyHexSchema = z.string().regex(/^[0-9a-fA-F]{32}$/, 'A key is 32 hex digits.');
const keysetName = { name: PlainLineSchema(40), diversify: z.boolean().default(true) };
/** Entered keys, or `generate: true` (recommended). */
export const CreateTagKeysetSchema = z.union([
  z.strictObject({ ...keysetName, generate: z.literal(true) }),
  z.strictObject({ ...keysetName, metaKey: KeyHexSchema, fileKey: KeyHexSchema }),
]);
/** The generated keys are shown once, in this response. */
export const CreatedTagKeysetSchema = TagKeysetSchema.extend({
  keys: z.object({ metaKey: KeyHexSchema, fileKey: KeyHexSchema }).nullable(),
});
/** The org policy, `settings` key `nfc.tags`. */
export const TagPolicySchema = z.object({
  enabled: z.boolean().default(false),
  accept: TagAssuranceSchema.default('basic'),
});
export type TagPolicy = z.infer<typeof TagPolicySchema>;

/** A tag as its holder sees it in the portal. */
export const MeTagSchema = z.object({
  id: IdSchema,
  passId: IdSchema,
  scope: TagScopeSchema,
  label: z.string().nullable(),
  hint: z.string().regex(/^[0-9A-F]{4}$/),
  assurance: TagAssuranceSchema,
  orgName: z.string(),
  addedAt: TimestampSchema,
  lostAt: TimestampSchema.nullable(),
});
