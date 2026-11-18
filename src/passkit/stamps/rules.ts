// Stamp arithmetic shared by the pass build, the scanner and the goal-change flow.
import { COUNTER_COPY } from '../../shared/copy/counters.ts';
import { scanLine } from '../../shared/copy/scan.ts';
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

export interface CounterScope {
  /** What is left; may exceed `size` after a refill that carries over. */
  left: number;
  /** `size` less what is left, never below 0. */
  used: number;
  size: number;
  /** Nothing left. */
  none: boolean;
  /** "7 left", or "None left". */
  text: string;
}

export const counterText = (left: number): string =>
  left > 0 ? scanLine(COUNTER_COPY.left, { n: left }) : COUNTER_COPY.none;

/** `pass.counters.<id>.*` for a count that goes down from `size`. */
export function counterScope(left: number, size: number): CounterScope {
  const n = Math.max(0, Math.floor(left));
  return { left: n, used: Math.max(0, size - n), size, none: n === 0, text: counterText(n) };
}

/** Adds `count` stamps. Past `max` it is refused (null): the card is full until a redeem. */
export const addStamps = (stamps: number, count: number, max: number): number | null =>
  stamps + count <= max ? stamps + count : null;

/** Redeem takes the goal off. Below the goal it is refused (null). */
export const redeem = (stamps: number, goal: number): number | null =>
  stamps >= goal ? stamps - goal : null;

/**
 * The count a pass keeps when the goal changes. `keepReady` tops up a ready card on a raise by
 * what the goal grew beyond the highest goal it was ever topped up to (`kept`, 0 when never): a
 * rollback and a second release never top it up twice.
 */
export function countAfterGoalChange(
  stamps: number,
  oldGoal: number,
  newGoal: number,
  keepReady: boolean,
  kept = 0,
): number {
  const from = Math.max(oldGoal, kept);
  return keepReady && newGoal > from && stamps >= oldGoal ? stamps + (newGoal - from) : stamps;
}

/** `fieldSources` key that records the goal a card was last topped up to: `stamps.kept:15`. */
const KEPT = 'stamps.kept:';

/** The highest goal a card was topped up to, from its field sources (0 when never). */
export function keptGoalOf(fieldSources: Readonly<Record<string, unknown>>): number {
  let kept = 0;
  for (const key of Object.keys(fieldSources))
    if (key.startsWith(KEPT)) kept = Math.max(kept, Number(key.slice(KEPT.length)) || 0);
  return kept;
}

/** The field sources with the top-up to `goal` recorded in place of any earlier one. */
export function withKeptGoal<V extends string>(
  fieldSources: Readonly<Record<string, V>>,
  goal: number,
  value: NoInfer<V>,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [key, v] of Object.entries(fieldSources)) if (!key.startsWith(KEPT)) out[key] = v;
  out[`${KEPT}${goal}`] = value;
  return out;
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
  /** The goal these cards were last topped up to (0 when never). */
  kept?: number;
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
  for (const { stamps, cards, goal, kept = 0 } of buckets) {
    out.passes += cards;
    out.highest = Math.max(out.highest, stamps);
    out.highestKept = Math.max(
      out.highestKept,
      countAfterGoalChange(stamps, goal, newGoal, true, kept),
    );
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
