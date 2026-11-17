import { z } from 'zod';
import { GOAL_MAX, GOAL_MIN } from '../../passkit/stamps/layout.ts';
import { IdSchema } from './common.ts';

export const StampsImpactQuerySchema = z.object({
  goal: z.coerce.number().int().min(GOAL_MIN).max(GOAL_MAX),
  orgId: IdSchema.optional(),
});

/** What a goal change does to the template's live cards. */
export const StampsImpactSchema = z.object({
  passes: z.number().int(),
  /** Ready at their own version's goal. */
  readyNow: z.number().int(),
  /** Ready now, short at the new goal, unless their rewards are kept. */
  readyLost: z.number().int(),
  /** Short now, ready at the new goal: alerted on the reissue. */
  newlyReady: z.number().int(),
  highest: z.number().int(),
  /** The highest count once ready cards are topped up ("Keep their rewards ready"). */
  highestKept: z.number().int(),
});

/** Add stamps to one card, or redeem its reward (takes the goal off; extra stamps carry over). */
export const PassStampsActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    count: z.number().int().min(1).max(GOAL_MAX).default(1),
  }),
  z.object({ action: z.literal('redeem') }),
]);
export type PassStampsAction = z.infer<typeof PassStampsActionSchema>;

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
