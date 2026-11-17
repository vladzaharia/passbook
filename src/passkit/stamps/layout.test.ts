import { describe, expect, it } from 'vitest';
import { GOAL_MAX, GOAL_MIN, STRIP_SAFE, scanGrid, scanGridHeight, stampGrid } from './layout.ts';

/** Positions snap to 1/6 pt, so an edge may sit 1/12 pt past the band. */
const SNAP = 1 / 12 + 1e-9;
const goals = Array.from({ length: GOAL_MAX - GOAL_MIN + 1 }, (_, i) => GOAL_MIN + i);

describe('stampGrid', () => {
  it.each(goals)('goal %i keeps every disc inside the safe band', (goal) => {
    const { cells } = stampGrid(goal);
    expect(cells).toHaveLength(goal);
    for (const c of cells) {
      expect(c.cx - c.d / 2).toBeGreaterThanOrEqual(STRIP_SAFE.x - SNAP);
      expect(c.cx + c.d / 2).toBeLessThanOrEqual(STRIP_SAFE.x + STRIP_SAFE.w + SNAP);
      expect(c.cy - c.d / 2).toBeGreaterThanOrEqual(STRIP_SAFE.y - SNAP);
      expect(c.cy + c.d / 2).toBeLessThanOrEqual(STRIP_SAFE.y + STRIP_SAFE.h + SNAP);
    }
  });

  it.each(goals)('goal %i has no overlapping discs', (goal) => {
    const { cells } = stampGrid(goal);
    for (const a of cells)
      for (const b of cells)
        if (a.index < b.index)
          expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeGreaterThanOrEqual(a.d - SNAP);
  });

  it.each(goals)('goal %i ends with an untilted reward, last in reading order', (goal) => {
    const { cells } = stampGrid(goal);
    const last = cells[goal - 1];
    expect(last?.reward).toBe(true);
    expect(last?.tilt).toBe(0);
    expect(cells.filter((c) => c.reward)).toHaveLength(1);
    for (const c of cells.slice(1)) {
      const p = cells[c.index - 1];
      expect(c.row > (p?.row ?? 0) || c.cx > (p?.cx ?? 0)).toBe(true);
    }
  });

  it.each(goals)('goal %i snaps positions to 1/6 pt', (goal) => {
    for (const c of stampGrid(goal).cells) {
      for (const v of [c.cx, c.cy, c.d])
        expect(Math.abs(v * 6 - Math.round(v * 6))).toBeLessThan(1e-9);
    }
  });

  it('follows the row rule', () => {
    expect(stampGrid(6).rows).toEqual([6]);
    expect(stampGrid(7).rows).toEqual([4, 3]);
    expect(stampGrid(18).rows).toEqual([9, 9]);
    expect(stampGrid(20).rows).toEqual([7, 7, 6]);
  });

  it('keeps discs legible', () => {
    for (const goal of goals) expect(stampGrid(goal).d).toBeGreaterThanOrEqual(27);
  });

  it('rejects goals out of range', () => {
    expect(() => stampGrid(2)).toThrow(RangeError);
    expect(() => stampGrid(21)).toThrow(RangeError);
    expect(() => stampGrid(4.5)).toThrow(RangeError);
  });

  it('is the same twice', () => {
    expect(stampGrid(12)).toEqual(stampGrid(12));
  });
});

describe('scanGrid', () => {
  it.each(goals)('goal %i fits a 318 px phone panel and a 548 px iPad panel', (goal) => {
    for (const width of [318, 548]) {
      const grid = scanGrid(goal, width);
      for (const c of grid.cells) {
        expect(c.cx - c.d / 2).toBeGreaterThanOrEqual(-0.01);
        expect(c.cx + c.d / 2).toBeLessThanOrEqual(width + SNAP);
      }
      expect(grid.cells[goal - 1]?.reward).toBe(true);
    }
  });

  it('uses one row to 10 on a wide panel, two above', () => {
    expect(scanGrid(10, 548).rows).toEqual([10]);
    expect(scanGrid(11, 548).rows).toEqual([6, 5]);
  });

  it('measures its height', () => {
    expect(scanGridHeight(scanGrid(10, 318))).toBe(2 * 44 + 10);
  });
});
