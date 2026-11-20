import { z } from 'zod';
import { IdSchema, pageOf, TimestampSchema } from './common.ts';

export const HoldParamsSchema = z.strictObject({ orgId: IdSchema });
export const HoldIdParamsSchema = z.strictObject({ orgId: IdSchema, holdId: IdSchema });
export const PlatformReceiptParamsSchema = z.strictObject({ receiptId: IdSchema });
export const ReceiptIdParamsSchema = z.strictObject({ orgId: IdSchema, receiptId: IdSchema });

/** Leave `passId` out to hold the whole organization. */
export const PlaceHoldSchema = z.strictObject({
  passId: IdSchema.nullish(),
  reason: z.string().trim().min(1, 'Give a reason.').max(500, 'Up to 500 characters.'),
});

export const HoldSchema = z.object({
  id: IdSchema,
  /** Null: every record of the organization. */
  passId: IdSchema.nullable(),
  passLabel: z.string().nullable(),
  /** Platform holds name PassBook, never the administrator. */
  placedByKind: z.enum(['org', 'platform']),
  placedByLabel: z.string(),
  /** Null for a PassBook hold read by the organization. */
  reason: z.string().nullable(),
  createdAt: TimestampSchema,
  releasedAt: TimestampSchema.nullable(),
  releasedByLabel: z.string().nullable(),
  /** The caller may release it: an org administrator cannot release a platform hold. */
  canRelease: z.boolean(),
});
export const HoldListSchema = pageOf(HoldSchema);

export const ReceiptSchema = z.object({
  id: IdSchema,
  cls: z.string(),
  kind: z.enum(['sweep', 'visitor', 'erasure']),
  ranAt: TimestampSchema,
  cutoffAt: TimestampSchema.nullable(),
  policyDays: z.number().int().nullable(),
  deleted: z.number().int(),
  anonymised: z.number().int(),
  /** The MAC and chain check out. */
  verified: z.boolean(),
});
export const ReceiptListSchema = pageOf(ReceiptSchema);
export const ReceiptListQuerySchema = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** The file a download returns: everything needed to check the receipt offline. */
export const ReceiptFileSchema = z.object({
  receipt: ReceiptSchema.extend({
    orgId: IdSchema.nullable(),
    seq: z.number().int(),
    prevMac: z.string().nullable(),
    mac: z.string(),
    refsDigest: z.string().nullable(),
    requestId: z.string().nullable(),
  }),
});
