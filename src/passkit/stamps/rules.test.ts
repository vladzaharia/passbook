import { describe, expect, it } from 'vitest';
import {
  addStamps,
  countAfterGoalChange,
  goalImpact,
  isGoal,
  maxStamps,
  minimumMaximum,
  redeem,
  stampScope,
} from './rules.ts';

describe('stampScope', () => {
  it('reads a card in progress', () => {
    expect(stampScope(7, 10)).toEqual({ goal: 10, card: 7, left: 3, ready: false, extra: 0 });
  });
  it('reads a full card with extras', () => {
    expect(stampScope(12, 10)).toEqual({ goal: 10, card: 10, left: 0, ready: true, extra: 2 });
  });
  it('is ready exactly at the goal', () => {
    expect(stampScope(10, 10).ready).toBe(true);
    expect(stampScope(9, 10).ready).toBe(false);
  });
});

describe('goal rules', () => {
  it('accepts 3 to 20 only', () => {
    expect([2, 3, 20, 21, 7.5, '8'].map(isGoal)).toEqual([false, true, true, false, false, false]);
  });
  it('holds a full card plus goal - 1 saved', () => {
    expect(maxStamps(10)).toBe(19);
    expect(maxStamps(3)).toBe(5);
  });
  it('redeems the goal and carries the rest', () => {
    expect(redeem(12, 10)).toBe(2);
    expect(redeem(10, 10)).toBe(0);
    expect(redeem(9, 10)).toBeNull();
  });
  it('never leaves a card ready twice in a row', () => {
    for (let goal = 3; goal <= 20; goal++) expect(redeem(maxStamps(goal), goal)).toBeLessThan(goal);
  });
});

describe('goal changes', () => {
  it('keeps ready cards ready on a raise', () => {
    expect(countAfterGoalChange(10, 8, 12, true)).toBe(14);
    expect(countAfterGoalChange(7, 8, 12, true)).toBe(7);
    expect(countAfterGoalChange(10, 8, 12, false)).toBe(10);
  });
  it('leaves counts alone on a lowering', () => {
    expect(countAfterGoalChange(9, 10, 8, true)).toBe(9);
  });
  it('counts who is ready, who loses it and who is alerted', () => {
    const at10 = (stamps: number) => ({ stamps, cards: 1, goal: 10 });
    const impact = goalImpact([0, 7, 8, 9, 10, 15].map(at10), 8);
    expect(impact).toEqual({
      passes: 6,
      readyNow: 2,
      readyLost: 0,
      newlyReady: 2,
      highest: 15,
      highestKept: 15,
    });
    const at8 = (stamps: number) => ({ stamps, cards: 1, goal: 8 });
    expect(goalImpact([9, 10, 12].map(at8), 12)).toMatchObject({
      readyNow: 3,
      readyLost: 2,
      highest: 12,
      highestKept: 16,
    });
  });
  it('reads each card against the goal of its own version', () => {
    const impact = goalImpact(
      [
        { stamps: 9, cards: 2, goal: 8 },
        { stamps: 9, cards: 3, goal: 10 },
      ],
      12,
    );
    expect(impact).toMatchObject({ passes: 5, readyNow: 2, readyLost: 2, highestKept: 13 });
  });
  it('adds stamps up to the maximum and refuses past it', () => {
    expect(addStamps(7, 1, 19)).toBe(8);
    expect(addStamps(18, 1, 19)).toBe(19);
    expect(addStamps(19, 1, 19)).toBeNull();
    expect(addStamps(17, 3, 19)).toBeNull();
  });
  it('never sets a maximum below a live count', () => {
    expect(minimumMaximum(8, 15)).toBe(15);
    expect(minimumMaximum(8, 3)).toBe(15);
    expect(minimumMaximum(8, 20)).toBe(20);
  });
});
