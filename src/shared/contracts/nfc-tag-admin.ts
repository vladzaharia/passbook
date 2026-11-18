import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';
import { TagBindingSchema, TagSchema, TagScopeSchema } from './nfc-tags.ts';

/** What an admin changes on a tag that is bound, and the device's answers to a tag request. */
export const TagScannerQuerySchema = z.object({ orgId: IdSchema });
/** Change what a binding works with: this pass, or the holder's every pass. `passId` narrows a person-wide tag. */
export const ChangeTagBindingSchema = z.strictObject({
  binding: TagScopeSchema,
  passId: IdSchema.optional(),
});
/** Put a removed tag back (Undo): the tag must be unassigned and have been removed from this pass in the last 10 minutes. */
export const RebindTagSchema = z.strictObject({ tagId: IdSchema, binding: TagScopeSchema });
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

/** What the device shows when its tag was bound. */
export const ScanTagEnrollmentDoneSchema = z.object({
  status: z.literal('done'),
  hint: z.string().regex(/^[0-9A-F]{4}$/),
  scope: TagScopeSchema,
  bindingId: IdSchema,
});
export const ScanTagEnrollmentDeclinedSchema = z.object({ status: z.literal('declined') });
