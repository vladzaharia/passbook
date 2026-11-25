import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.ts';
import { UuidV7Schema } from './scan-base.ts';
import { ScanCustomerViewSchema } from './scan-customer.ts';

/** The money a desk is about to take or add, for the customer screens that follow this scanner. */
export const ScanDraftRequestSchema = z.strictObject({
  /** The `idempotencyKey` of the resolve that read the pass. */
  ref: UuidV7Schema,
  actionId: z.string().min(1).max(32),
  amount: z.number().finite(),
});
export type ScanDraftRequest = z.infer<typeof ScanDraftRequestSchema>;

export const ScanDraftRefSchema = z.object({
  ref: UuidV7Schema,
  /** `ready`: only the draft goes (the amount field closed or emptied); the ready card stays. */
  keep: z.literal('ready').optional(),
});

/** How many customer screens were told. */
export const ScanDraftResultSchema = z.object({ screens: z.number().int().nonnegative() });

/**
 * A customer screen's draft message. `ref` is the ready card's row id. `customer` is the review body;
 * `cancelled` clears the draft and the ready card with that `ref`, or only the draft with `keep: 'ready'`.
 * The latest `at` wins.
 */
export const ScanLiveDraftSchema = z.union([
  z.strictObject({
    ref: IdSchema,
    at: TimestampSchema,
    /** The desk that drafted: a later result from it ends the draft. Rows already carry it. */
    scannerId: IdSchema,
    /** The ready card's own time: any later row from that desk ends this draft. */
    readyAt: TimestampSchema,
    customer: ScanCustomerViewSchema,
  }),
  z.strictObject({
    ref: IdSchema,
    at: TimestampSchema,
    cancelled: z.literal(true),
    keep: z.literal('ready').optional(),
  }),
]);
export type ScanLiveDraft = z.infer<typeof ScanLiveDraftSchema>;
