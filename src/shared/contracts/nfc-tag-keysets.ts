import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';
import { CreatedTagKeysetSchema, KeyHexSchema, TagKeysetSchema } from './nfc-tags.ts';

/** Secure tag keysets. No response ever carries a key except the one that made it, once. */
export const TagKeyStateSchema = z.enum(['active', 'retiring', 'retired']);
export const TagKeyVersionSchema = z.object({
  version: z.number().int().min(1).max(255),
  state: TagKeyStateSchema,
  createdAt: TimestampSchema,
  stateAt: TimestampSchema.nullable(),
  /** Cut off at once, with tags still on it. */
  revokedAt: TimestampSchema.nullable(),
  /** Tags whose last read used this version. */
  tags: z.number().int().nonnegative(),
});
export const TagKeysetViewSchema = TagKeysetSchema.extend({
  versions: z.array(TagKeyVersionSchema),
});
/** The create and rotate answer: the keys, when generated, are in `keys` and nowhere else. */
export const MadeTagKeysetSchema = CreatedTagKeysetSchema.extend({
  versions: z.array(TagKeyVersionSchema),
});
export const TagKeysetListQuerySchema = z.object({ orgId: IdSchema });
export const TagKeysetListSchema = pageOf(TagKeysetViewSchema);
/** Entered keys, or `generate: true` (recommended). A keyset of imported tags takes the new meta key only. */
export const RotateTagKeysetSchema = z.union([
  z.strictObject({ generate: z.literal(true) }),
  z.strictObject({ metaKey: KeyHexSchema, fileKey: KeyHexSchema }),
  z.strictObject({ metaKey: KeyHexSchema }),
]);
/** Moves the tags of the keyset in the path, those without a key of their own, to another live keyset. */
export const ReenrolTagKeysetSchema = z.strictObject({ toKeysetId: IdSchema });
export const ReenrolledTagKeysetSchema = z.object({
  /** Tags moved. They work again once written with the new keyset's keys. */
  moved: z.number().int().nonnegative(),
  /** Tags left where they are: they hold keys of their own. */
  ownKey: z.number().int().nonnegative(),
  keyset: TagKeysetViewSchema,
});

export const TAG_IMPORT_MAX_ROWS = 500;
export const TAG_IMPORT_MAX_CHARS = 60_000;
/** A CSV of supplier-personalised tags: `uid` and `key` per line, a header line optional. */
export const ImportTagsSchema = z.strictObject({
  csv: z.string().min(1).max(TAG_IMPORT_MAX_CHARS),
  dryRun: z.boolean(),
});
export const TagImportProblemSchema = z.object({
  /** 1-based line of the file. */
  line: z.number().int().positive(),
  /** The tag ID as read, never the key. */
  uid: z.string().max(40).nullable(),
  reason: z.enum(['bad_uid', 'bad_key', 'weak_key', 'dup_file', 'dup_key', 'meta_key', 'exists']),
});
export const TagImportResultSchema = z.object({
  dryRun: z.boolean(),
  rows: z.number().int().nonnegative(),
  /** Rows that are, or on a dry run would be, added. */
  ok: z.number().int().nonnegative(),
  /** Added now: 0 on a dry run. */
  added: z.number().int().nonnegative(),
  problems: z.array(TagImportProblemSchema).max(50),
  /** More problems than listed. */
  moreProblems: z.number().int().nonnegative(),
});
export const TagKeyVersionParamSchema = z.object({
  id: IdSchema,
  version: z.coerce.number().int().min(1).max(255),
});
