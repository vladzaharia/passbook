import { z } from 'zod';
import { EmailSchema, IdSchema, TimestampSchema } from './common.ts';

/** unassigned: no email, no owner. waiting: email, no owner. owned: an owner is attached. */
export const HolderStateSchema = z.enum(['unassigned', 'waiting', 'owned']);

/** Pending transfers retain the previous assignment in the record, but its credentials are blocked. */
export const HolderTransferSchema = z.object({
  transferId: IdSchema,
  state: z.enum(['pending', 'completed']),
});

export const HolderSchema = z.object({
  passId: IdSchema,
  state: HolderStateSchema,
  email: z.string().nullable(),
  ownerUserId: IdSchema.nullable(),
  ownerName: z.string().nullable(),
  blockedUserIds: z.array(IdSchema),
  transfer: HolderTransferSchema.nullable(),
  reissueRequired: z.boolean(),
  updatedAt: TimestampSchema,
});
export type HolderDto = z.infer<typeof HolderSchema>;

export const HolderListQuerySchema = z.object({
  email: z.string().max(254).optional(),
  state: HolderStateSchema.optional(),
  /** Org-bound API keys may omit it. */
  orgId: IdSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const HolderListSchema = z.object({
  items: z.array(HolderSchema),
  nextCursor: z.string().nullable(),
});

/** Stage a holder change; the current assignment remains in place while transfer is pending. */
export const AssignHolderSchema = z.object({ passId: IdSchema, email: EmailSchema });
/** Stage an explicit change of holder, including removal when email is null. */
export const ReassignHolderSchema = z.object({ passId: IdSchema, email: EmailSchema.nullable() });
export const UnassignHolderSchema = z.object({ passId: IdSchema });
export const AssignHoldersBulkSchema = z.object({
  items: z.array(AssignHolderSchema).min(1).max(100),
});
export const ClearBlockSchema = z.object({ passId: IdSchema, userId: IdSchema });
