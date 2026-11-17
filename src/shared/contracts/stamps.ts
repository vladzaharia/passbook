import { z } from 'zod';
import { GOAL_MAX, GOAL_MIN } from '../../passkit/stamps/goal.ts';
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

export { type PassStampsDto, PassStampsSchema } from './pass-stamps.ts';
