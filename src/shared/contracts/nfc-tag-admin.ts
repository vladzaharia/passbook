import { z } from 'zod';
import { IdSchema, PlainLineSchema, pageOf, TimestampSchema } from './common.ts';
import {
  TagBindingSchema,
  TagConfirmSchema,
  TagIdFormatSchema,
  TagSchema,
  TagScopeSchema,
  TagSystemSchema,
  TagUseSchema,
} from './nfc-tags.ts';

/** What an admin changes on a tag that is bound, and the device's answers to a tag request. */
/** Change what a binding works with: this pass, or the holder's every pass. `passId` narrows a person-wide tag. */
export const ChangeTagBindingSchema = z.strictObject({
  binding: TagScopeSchema,
  passId: IdSchema.optional(),
});
/** Put a removed tag back (Undo): the tag must be unassigned and have been removed from this pass in the last 10 minutes. */
export const RebindTagSchema = z.strictObject({ tagId: IdSchema, binding: TagScopeSchema });
/** Assign from the admin without a scanner: a typed tag ID, or an existing spare tag. */
export const AssignTagSchema = z.union([
  z.strictObject({
    id: z.string().trim().min(1).max(40),
    format: TagIdFormatSchema.optional(),
    binding: TagScopeSchema,
    label: PlainLineSchema(40).optional(),
  }),
  z.strictObject({ tagId: IdSchema, binding: TagScopeSchema }),
]);
export const TagHistoryEventSchema = z.object({
  at: TimestampSchema,
  action: z.enum(['lost', 'retire', 'restore', 'update']),
  actorName: z.string().nullable(),
});
/** Every binding the tag has had, newest first, and the changes made to the tag itself. */
export const TagHistorySchema = pageOf(TagBindingSchema).extend({
  events: z.array(TagHistoryEventSchema),
});
export const UserTagSchema = TagSchema.extend({ orgId: IdSchema, orgName: z.string() });
/** `orgId` narrows to one org; absent, every org the caller can read passes in. */
export const UserTagListQuerySchema = z.object({ orgId: IdSchema.optional() });
export const UserTagListSchema = pageOf(UserTagSchema);

/** Which pass or person a type's tags work with. */
export const TagTypeScopesSchema = z.enum(['pass', 'user', 'both']);
const typeFields = {
  name: PlainLineSchema(40),
  use: TagUseSchema,
  scopes: TagTypeScopesSchema.default('both'),
  /** At most this many tags of the type on one pass. */
  perPass: z.number().int().min(1).max(4).default(1),
  /** A binding ends this many days after it is made; null: never. */
  bindingDays: z.number().int().min(1).max(3650).nullable().default(null),
  confirm: TagConfirmSchema.default('none'),
  /** Admins may type IDs of this type (Basic only). */
  typed: z.boolean().default(true),
  /** Passes of these templates only; empty: any template. */
  templateIds: z.array(IdSchema).max(50).default([]),
};
export const TagTypeSchema = z.object({
  id: IdSchema,
  system: TagSystemSchema,
  ...typeFields,
  version: z.number().int().min(1),
  /** Active tags of this type. */
  tagCount: z.number().int().min(0).default(0),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
});
export type TagType = z.infer<typeof TagTypeSchema>;
export const TagTypeListSchema = pageOf(TagTypeSchema);
/** Oldest first; `cursor` is the last id of the previous page. */
export const TagTypeListQuerySchema = z.object({
  orgId: IdSchema.optional(),
  cursor: IdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
/** A Secure type needs the `sun` system; typed IDs are Basic only. */
export const CreateTagTypeSchema = z
  .strictObject({ ...typeFields, system: TagSystemSchema.default('uid') })
  .refine((t) => t.system === 'uid' || !t.typed, 'Secure tags cannot be typed.');
/** `version` is the one the editor read; a stale one is refused. `system` never changes. */
export const UpdateTagTypeSchema = z.strictObject({
  version: z.number().int().min(1),
  name: typeFields.name.optional(),
  use: typeFields.use.optional(),
  scopes: TagTypeScopesSchema.optional(),
  perPass: typeFields.perPass.optional(),
  bindingDays: typeFields.bindingDays.optional(),
  confirm: typeFields.confirm.optional(),
  typed: z.boolean().optional(),
  templateIds: typeFields.templateIds.optional(),
});

/** A tag typed or picked in the console. A spare is `tagId`; a typed ID is `uid`. */
export const AdminBindTagSchema = z.union([
  z.strictObject({ tagId: IdSchema, binding: TagScopeSchema }),
  z.strictObject({
    uid: z.string().trim().min(1).max(40),
    format: TagIdFormatSchema.optional(),
    binding: TagScopeSchema,
    typeId: IdSchema.optional(),
    label: PlainLineSchema(40).optional(),
  }),
]);
/** Spares from typed IDs, no pass. */
export const CreateSpareTagsSchema = z.strictObject({
  ids: z.array(z.string().trim().min(1).max(40)).min(1).max(200),
  format: TagIdFormatSchema.optional(),
  typeId: IdSchema.optional(),
  label: PlainLineSchema(40).optional(),
});
export const CreatedSpareTagsSchema = z.object({
  created: z.number().int().min(0),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })).max(200),
});
