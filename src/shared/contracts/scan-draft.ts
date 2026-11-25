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

export const ScanDraftRefSchema = z.object({ ref: UuidV7Schema });

/** How many customer screens were told. */
export const ScanDraftResultSchema = z.object({ screens: z.number().int().nonnegative() });

/**
 * A customer screen's draft message. `ref` is the ready card's row id. `customer` is the review body;
 * `cancelled` clears the draft and the ready card with that `ref`. The latest `at` wins.
 */
export const ScanLiveDraftSchema = z.union([
  z.strictObject({ ref: IdSchema, at: TimestampSchema, customer: ScanCustomerViewSchema }),
  z.strictObject({ ref: IdSchema, at: TimestampSchema, cancelled: z.literal(true) }),
]);
export type ScanLiveDraft = z.infer<typeof ScanLiveDraftSchema>;
