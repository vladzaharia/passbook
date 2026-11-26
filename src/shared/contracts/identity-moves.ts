import { z } from 'zod';
import { IdSchema, PageQuerySchema, pageOf, TimestampSchema } from './common.ts';

export const IdentityMoveStateSchema = z.enum([
  'planned',
  'issued',
  'notified',
  'registered',
  'voided',
  'kept',
  'kept_both',
  'failed',
]);

/** Names the org and the identity its passes leave; the target defaults to the org's issuing identity. */
export const IdentityMoveRequestSchema = z.object({
  orgId: IdSchema,
  fromIdentityId: IdSchema,
  toIdentityId: IdSchema.nullish(),
});

export const IdentityMoveOrgQuerySchema = z.object({
  orgId: IdSchema,
  fromIdentityId: IdSchema,
  toIdentityId: IdSchema.optional(),
});

export const IdentityMovePreviewSchema = z.object({
  toIdentityId: IdSchema,
  /** Passes that would move. */
  passes: z.number().int().nonnegative(),
  /** Of those, the ones with a device registration. */
  registered: z.number().int().nonnegative(),
  holders: z.number().int().nonnegative(),
  /** Passes that stay on the old identity, by reason (connection, user_tag, transfer). */
  kept: z.record(z.string(), z.number().int().nonnegative()),
});

export const IdentityMoveListQuerySchema = PageQuerySchema.extend({
  orgId: IdSchema.optional(),
  operationId: IdSchema.optional(),
  state: IdentityMoveStateSchema.optional(),
  /** `unarmed`: registered for 7 days without the void arming. */
  reason: z.string().min(1).max(40).optional(),
});

export const IdentityMoveSchema = z.object({
  id: IdSchema,
  operationId: IdSchema,
  orgId: IdSchema,
  fromIdentityId: IdSchema,
  toIdentityId: IdSchema,
  oldPassId: IdSchema,
  newPassId: IdSchema,
  state: IdentityMoveStateSchema,
  /** Why the row is kept, kept_both (`wallet_copy:<providers>` when a device holds a Google or Samsung copy the replacement lacks), failed or unarmed. */
  reason: z.string().nullable(),
  /** Fields edited on both passes since the copy. */
  conflictCount: z.number().int().nonnegative(),
  registeredAt: TimestampSchema.nullable(),
  voidAt: TimestampSchema.nullable(),
  voidedAt: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
});
export type IdentityMoveDto = z.infer<typeof IdentityMoveSchema>;
export const IdentityMoveListSchema = pageOf(IdentityMoveSchema);

export const IdentityMoveParamSchema = z.object({ moveId: IdSchema });
export const IdentityMoveArmedSchema = z.object({ moveId: IdSchema, armed: z.literal(true) });
