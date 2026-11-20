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
/** Entered keys, or `generate: true` (recommended). */
export const RotateTagKeysetSchema = z.union([
  z.strictObject({ generate: z.literal(true) }),
  z.strictObject({ metaKey: KeyHexSchema, fileKey: KeyHexSchema }),
]);
export const TagKeyVersionParamSchema = z.object({
  id: IdSchema,
  version: z.coerce.number().int().min(1).max(255),
});
