import { z } from 'zod';
import { CursorQuerySchema, IdSchema, pageOf, TimestampSchema } from './common.ts';
import { SETUP_TROUBLE_KEYS } from './connection-setup.ts';

export const ArrivalOutcomeSchema = z.enum(['accepted', 'duplicate', 'ignored', 'rejected']);
// The ledger's reasons are the guides' troubleshooting keys, less `none` (no arrival at all).
const [, ...ARRIVAL_REASONS] = SETUP_TROUBLE_KEYS;
export const ArrivalReasonSchema = z.enum(ARRIVAL_REASONS);
/** One inbound webhook delivery, or the deliveries of one minute with the same result. It holds no body. */
export const ArrivalSchema = z.object({
  id: IdSchema,
  receivedAt: TimestampSchema,
  /** The latest delivery counted into this row. */
  lastAt: TimestampSchema,
  outcome: ArrivalOutcomeSchema,
  reason: ArrivalReasonSchema.nullable(),
  /** One of the recipe's own topics, `other`, or null. Never text from the sender. */
  topic: z.string().max(100).nullable(),
  contentClass: z.enum(['json', 'xml', 'form', 'other']),
  /** The signed event id of an accepted or duplicate event. */
  eventRef: z.string().max(200).nullable(),
  /** Signed with the previous secret: the sender has not switched to the new one. */
  usedPrevious: z.boolean(),
  /** Deliveries counted into this row. */
  count: z.number().int().min(1),
});
export type ArrivalDto = z.infer<typeof ArrivalSchema>;
export const ArrivalListSchema = pageOf(ArrivalSchema);
export const ArrivalListQuerySchema = CursorQuerySchema.extend({
  /** Only rows seen or counted again after this time (ms). */
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
// The table keeps 50 rows per connection, so one page is the whole list and nextCursor is always null.
