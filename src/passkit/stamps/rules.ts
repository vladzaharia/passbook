// Stamp arithmetic shared by the pass build, the scanner and the goal-change flow.
import { GOAL_MAX, GOAL_MIN } from './layout.ts';

export const isGoal = (goal: unknown): goal is number =>
  typeof goal === 'number' && Number.isInteger(goal) && goal >= GOAL_MIN && goal <= GOAL_MAX;

/** One full card plus up to goal - 1 saved. */
export const maxStamps = (goal: number): number => 2 * goal - 1;

export interface StampScope {
  goal: number;
  /** Stamps on the current card, 0 to goal. */
  card: number;
  left: number;
  ready: boolean;
  /** Stamps over the goal. */
  extra: number;
}

export function stampScope(stamps: number, goal: number): StampScope {
  const count = Math.max(0, Math.floor(stamps));
  const card = Math.min(count, goal);
  return { goal, card, left: goal - card, ready: count >= goal, extra: Math.max(0, count - goal) };
}

/** Adds `count` stamps. Past `max` it is refused (null): the card is full until a redeem. */
export const addStamps = (stamps: number, count: number, max: number): number | null =>
  stamps + count <= max ? stamps + count : null;

/** Redeem takes the goal off. Below the goal it is refused (null). */
export const redeem = (stamps: number, goal: number): number | null =>
  stamps >= goal ? stamps - goal : null;

/** The count a pass keeps when the goal changes. `keepReady` tops up ready cards on a raise. */
export function countAfterGoalChange(
  stamps: number,
  oldGoal: number,
  newGoal: number,
  keepReady: boolean,
): number {
  return keepReady && newGoal > oldGoal && stamps >= oldGoal
    ? stamps + (newGoal - oldGoal)
    : stamps;
}

export interface GoalImpact {
  passes: number;
  /** Cards that are ready now (at their own goal). */
  readyNow: number;
  /** Cards ready now that would not be ready at the new goal, without keep-ready. */
  readyLost: number;
  /** Cards a lowering makes ready: the holders who are alerted. */
  newlyReady: number;
  highest: number;
  /** The highest count once ready cards are topped up ("Keep their rewards ready"). */
  highestKept: number;
}

/** One histogram bucket: `cards` live cards hold `stamps` on a version whose goal is `goal`. */
export interface StampBucket {
  stamps: number;
  cards: number;
  goal: number;
}

/** What moving every bucket to `newGoal` does. */
export function goalImpact(buckets: Iterable<StampBucket>, newGoal: number): GoalImpact {
  const out: GoalImpact = {
    passes: 0,
    readyNow: 0,
    readyLost: 0,
    newlyReady: 0,
    highest: 0,
    highestKept: 0,
  };
  for (const { stamps, cards, goal } of buckets) {
    out.passes += cards;
    out.highest = Math.max(out.highest, stamps);
    out.highestKept = Math.max(out.highestKept, countAfterGoalChange(stamps, goal, newGoal, true));
    if (stamps >= goal) {
      out.readyNow += cards;
      if (stamps < newGoal) out.readyLost += cards;
    } else if (stamps >= newGoal) out.newlyReady += cards;
  }
  return out;
}

/** The lowest maximum a goal change may set: it never drops below a live count. */
export const minimumMaximum = (goal: number, highest: number): number =>
  Math.max(maxStamps(goal), highest);
