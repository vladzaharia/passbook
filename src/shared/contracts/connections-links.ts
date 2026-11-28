import { z } from 'zod';
import { IdSchema, PageQuerySchema, pageOf, TimestampSchema } from './common.ts';

/** `record` is the object type of the pass's own binding (`passes.external_ref`), mirrored as `primary`. */
export const PRIMARY_LINK_OBJECT = 'record';

const ObjectTypeSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 'Use letters, digits, dots, dashes and underscores.');
const ExternalIdSchema = z.string().min(1).max(200);

export const LinkSchema = z.object({
  id: IdSchema,
  connectionId: IdSchema,
  objectType: z.string(),
  externalId: z.string(),
  localId: IdSchema,
  role: z.enum(['primary', 'secondary']),
  state: z.enum(['active', 'tombstoned']),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type LinkDto = z.infer<typeof LinkSchema>;
export const LinkListSchema = pageOf(LinkSchema);

export const CreateLinkSchema = z.object({
  objectType: ObjectTypeSchema.refine(
    (v) => v !== PRIMARY_LINK_OBJECT,
    'Reserved for the pass binding.',
  ),
  externalId: ExternalIdSchema,
  /** The pass the upstream object belongs to. */
  localId: IdSchema,
});

export const LinkListQuerySchema = PageQuerySchema.extend({
  objectType: ObjectTypeSchema.optional(),
  externalId: ExternalIdSchema.optional(),
});

export const LinkFindQuerySchema = LinkListQuerySchema.extend({
  connectionId: IdSchema.optional(),
  orgId: IdSchema.optional(),
});

export const LinkParamSchema = z.object({ id: IdSchema, linkId: IdSchema });
