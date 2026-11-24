import { z } from 'zod';
import { ScanChipSchema, ScanDisplayPanelSchema, ScanIconSchema } from './scan-display.ts';

/**
 * What a customer screen is sent. No reason, staff word, note, photo, pass or scan id, count or
 * other holder: the screen cannot correlate people. `ref` only orders and replaces bodies.
 */
export const ScanCustomerViewSchema = z.strictObject({
  v: z.literal(1),
  screen: z.enum(['ready', 'review', 'ok', 'see_desk']),
  ref: z.string().min(1).max(64),
  at: z.number().int().nonnegative(),
  where: z.string().max(40),
  band: z.strictObject({
    headline: z.string().max(40),
    sub: z.string().max(40).nullable(),
  }),
  /** The first name only, on ok, review and ready. */
  greet: z.string().max(24).nullable(),
  chips: z.array(ScanChipSchema).max(2),
  panel: ScanDisplayPanelSchema.nullable(),
  lines: z.array(z.strictObject({ icon: ScanIconSchema, text: z.string().max(40) })).max(2),
  milestone: z.enum(['count', 'all_in', 'reward']).nullable(),
  test: z.boolean(),
  /** The figure of a review body ("$12.00"), for the screen to set large under the headline. */
  amount: z.string().max(24).optional(),
  /** The session's own welcome line. Absent: the fixed copy. */
  welcome: z.string().max(40).optional(),
});
export type ScanCustomerView = z.infer<typeof ScanCustomerViewSchema>;
