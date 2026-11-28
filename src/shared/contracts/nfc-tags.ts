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
/**
 * Where a read came from: informational and untrusted, and the server ignores it. `reader` is an external
 * reader's full read; `keyboard` is a UID typed by a keyboard-mode reader, so it never carries `ndef`.
 */
export const TagSourceSchema = z.enum(['native', 'webnfc', 'reader', 'keyboard']);

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
  .refine((read) => read.uid !== undefined || read.ndef !== undefined, 'The read has no tag data.')
  .refine(
    (read) => read.source !== 'keyboard' || read.ndef === undefined,
    'A typed UID has no NDEF.',
  );
export type TagRead = z.infer<typeof TagReadSchema>;

export const TagAssuranceSchema = z.enum(['basic', 'secure']);
/** How a tag proves itself: `uid` is Basic, `sun` is Secure. */
export const TagSystemSchema = z.enum(['uid', 'sun']);
/** One release alias of `TagSystemSchema`; `Tag.kind` equals `Tag.system`. */
export const TagKindSchema = TagSystemSchema;
/** What a tag type is for. Templates name uses, never an org's type ids. */
export const TagUseSchema = z.enum(['member', 'staff', 'visitor']);
export type TagUse = z.infer<typeof TagUseSchema>;
/** A session or an admin names a type by id, or `standard` for a tag with no type. */
export const TagTypeKeySchema = z.union([IdSchema, z.literal('standard')]);
/** What an admin may type a tag ID as: as shown, byte-reversed, or a decimal number. */
export const TagIdFormatSchema = z.enum(['hex', 'reversed', 'decimal']);
/** The second factor a Basic tag needs at a door: nothing, a staff check or a Manager PIN. */
export const TagConfirmSchema = z.enum(['none', 'staff', 'manager']);
export const TagScopeSchema = z.enum(['pass', 'user']);
export const TagSourceKindSchema = z.enum(['scanner', 'remote', 'admin']);
export const TagStatusSchema = z.enum(['active', 'retired']);
/** What a list shows: `lent` is a loaner (a `visitor` type tag) on a pass; `assigned` excludes it; `lost` has no binding and was reported. */
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
  'channel_off',
  'expired',
  'type_changed',
]);
/** Who may assign tags on a scanner. */
export const TagAssignRoleSchema = z.enum(['desk', 'manager', 'never']);
/** A session's tag level; absent means the org's. */
export const TagLevelSchema = z.enum(['off', 'basic', 'secure']);
const TYPES_EMPTY = 'Name at least one tag type, or set the level to off.';
/**
 * `assign` binds a tag to the scanned pass, `assignAll` to the person. The rest is the door's tag policy: the
 * weakest tag it takes (`secure` refuses a Basic tag, `off` every tag; absent: any), the tag types it takes
 * (`standard` is a tag with no type; absent: all; never empty, `level: off` takes none) and what a Basic tag needs besides.
 */
export const ScannerTagsSettingsSchema = z.object({
  assign: TagAssignRoleSchema.default('desk'),
  assignAll: TagAssignRoleSchema.default('manager'),
  level: TagLevelSchema.optional(),
  types: z.array(TagTypeKeySchema).min(1, TYPES_EMPTY).max(12).optional(),
  confirmBasic: TagConfirmSchema.optional(),
});
/** The session's tag rules are the scanner's. */
export const SessionTagRulesSchema = ScannerTagsSettingsSchema;

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
  system: TagSystemSchema.optional(),
  /** The tag's type name; absent for Standard. */
  typeName: z.string().max(40).optional(),
  scope: TagScopeSchema,
  /** A user binding: how many of the holder's passes it read ("1 of {name}'s 3 passes"). */
  count: z.number().int().min(0).max(8).optional(),
  /** A user binding, Desk and up: each pass in the order it was tried. */
  passes: z.array(ScanTagPassSchema).max(8).optional(),
});
export type ScanTag = z.infer<typeof ScanTagSchema>;

export { TAG_ERROR_CODES, TagErrorCodeSchema } from './nfc-tag-errors.ts';

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
  /** True for a tag of a `visitor` type: a loaner, pass scope only. It ends at the desk return, the pass's end, or void or remove. */
  lent: z.boolean().default(false),
  boundAt: TimestampSchema,
  boundByName: z.string().nullable(),
  scannerName: z.string().nullable(),
  /** When the assignment ends by itself (the type's `binding_days`); null: it does not. */
  expiresAt: TimestampSchema.nullable().optional(),
  endedAt: TimestampSchema.nullable(),
  endCause: TagEndCauseSchema.nullable(),
});
export type TagBinding = z.infer<typeof TagBindingSchema>;

/** The type a tag has, as a list shows it. Absent: Standard. */
export const TagTypeRefSchema = z.object({ id: IdSchema, name: z.string(), use: TagUseSchema });

export const TagSchema = z.object({
  id: IdSchema,
  mode: ModeSchema,
  /** The same as `system`, for one more release. */
  kind: TagKindSchema,
  /** The server always sends `system`, `type` and `expiresAt`; they are optional so an older response still parses. */
  system: TagSystemSchema.optional(),
  type: TagTypeRefSchema.nullable().optional(),
  assurance: TagAssuranceSchema,
  /** The first four hex digits of the tag reference, never part of the UID. */
  hint: z.string().regex(/^[0-9A-F]{4}$/),
  label: z.string().nullable(),
  /** True when the tag's type has use `visitor`: a loaner. Set it through the type. */
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
  orgId: IdSchema.optional(),
  status: TagStateSchema.optional(),
  /** With `status=spare`: only the spares this pass's policy takes, assigned as `binding` (default `pass`). */
  passId: IdSchema.optional(),
  binding: TagScopeSchema.optional(),
  q: z.string().trim().max(80).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const TagListSchema = pageOf(TagSchema);

export const UpdateTagSchema = z.strictObject({
  label: PlainLineSchema(40).nullable().optional(),
  /** Refused (`TAG_POOL_UNSUPPORTED`): a loaner is a tag with a `visitor` type. */
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
  /** The type of a new tag; absent: the only type that fits, else the org's default, else Standard. */
  typeId: IdSchema.optional(),
  /** Move the tag from another holder. Needs a Manager PIN. */
  move: z.boolean().optional(),
  /** Refused (`TAG_POOL_UNSUPPORTED`): choose a `visitor` tag type with `typeId` instead. */
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
  /** The type the tag has or gets; null: Standard. */
  type: TagTypeRefSchema.nullable().optional(),
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
  /** What the template says the tag opens when nobody chooses; absent from older replies. */
  opensDefault: TagScopeSchema.optional(),
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
  /** The tags carry their own file keys, imported from the supplier. */
  perTag: z.boolean(),
  createdAt: TimestampSchema,
  disabledAt: TimestampSchema.nullable(),
});
export const KeyHexSchema = z.string().regex(/^[0-9a-fA-F]{32}$/, 'A key is 32 hex digits.');
const keysetName = { name: PlainLineSchema(40), diversify: z.boolean().default(true) };
/** Entered keys, `generate: true` (recommended), or `perTag`: the shared meta key only, each tag's own file key comes by import. */
export const CreateTagKeysetSchema = z.union([
  z.strictObject({ ...keysetName, generate: z.literal(true) }),
  z.strictObject({ ...keysetName, metaKey: KeyHexSchema, fileKey: KeyHexSchema }),
  z.strictObject({ name: PlainLineSchema(40), perTag: z.literal(true), metaKey: KeyHexSchema }),
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
