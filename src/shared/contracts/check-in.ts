import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';

export const CheckInModeSchema = z.enum(['single', 'daily', 'unlimited', 'in_out']);
export const SetupDirectionSchema = z.enum(['in', 'out', 'both']);

/** Omitted pass fields inherit template defaults; scanner fields add restrictions. */
export const CheckInPolicySchema = z
  .strictObject({
    mode: CheckInModeSchema.optional(),
    eventId: IdSchema.nullable().optional(),
    validFrom: TimestampSchema.nullable().optional(),
    validUntil: TimestampSchema.nullable().optional(),
    durationMinutes: z.number().int().min(1).max(5_256_000).nullable().optional(),
    durationFrom: z.enum(['first_scan', 'issued']).optional(),
  })
  .refine((p) => p.validFrom == null || p.validUntil == null || p.validUntil > p.validFrom, {
    message: 'End must be after start.',
    path: ['validUntil'],
  });
export type CheckInPolicy = z.infer<typeof CheckInPolicySchema>;

export const CheckInStateSchema = z.object({
  mode: CheckInModeSchema,
  direction: z.enum(['in', 'out']),
  inside: z.boolean(),
  enteredAt: TimestampSchema.nullable(),
  firstAt: TimestampSchema.nullable(),
  validFrom: TimestampSchema.nullable(),
  validUntil: TimestampSchema.nullable(),
});
export type CheckInState = z.infer<typeof CheckInStateSchema>;

export const PassCheckInSchema = z.object({
  passId: IdSchema,
  orgId: IdSchema,
  rules: CheckInPolicySchema,
  defaults: CheckInPolicySchema,
  effective: CheckInPolicySchema,
  updatedAt: TimestampSchema.nullable(),
});

export const PutPassCheckInSchema = z.object({ rules: CheckInPolicySchema });

export const MemberPhotoSchema = z.object({
  passId: IdSchema,
  orgId: IdSchema,
  url: z.string().nullable(),
  includeInPass: z.boolean(),
  walletSupported: z.boolean(),
  updatedAt: TimestampSchema.nullable(),
});
export const PutMemberPhotoSchema = z.object({
  png: z.string().min(1).max(1_400_000),
  includeInPass: z.boolean().default(false),
});
export const UpdateMemberPhotoSchema = z.object({ includeInPass: z.boolean() });
