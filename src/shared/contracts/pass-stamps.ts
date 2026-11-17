import { z } from 'zod';

/** A stamp card as its own template version counts it. */
export const PassStampsSchema = z.object({
  input: z.string(),
  goal: z.number().int(),
  /** Every stamp the pass holds, the carry-over included. */
  count: z.number().int(),
  /** Stamps on the current card, 0 to goal. */
  card: z.number().int(),
  ready: z.boolean(),
  /** The input's maximum: a full card plus the carry-over. */
  maximum: z.number().int(),
});
export type PassStampsDto = z.infer<typeof PassStampsSchema>;
