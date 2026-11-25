import { describe, expect, it } from 'vitest';
import { changeOpsOf } from '../../../shared/contracts/broadcasts-change.ts';
import { fillTokens, resolveOps, shiftDate, tokensOf } from './change-ops.ts';

describe('shiftDate', () => {
  it('moves days, weeks, months and years, back and forward', () => {
    expect(shiftDate('2026-03-10', 'P1D', 'UTC')).toBe('2026-03-11');
    expect(shiftDate('2026-03-10', '-P1W', 'UTC')).toBe('2026-03-03');
    expect(shiftDate('2026-03-10', 'P1Y2M', 'UTC')).toBe('2027-05-10');
    expect(shiftDate('2026-12-31', 'P1D', 'UTC')).toBe('2027-01-01');
  });

  it('clamps a month end, and keeps the time of a date-time', () => {
    expect(shiftDate('2026-01-31', 'P1M', 'UTC')).toBe('2026-02-28');
    expect(shiftDate('2024-02-29', 'P1Y', 'UTC')).toBe('2025-02-28');
    expect(shiftDate('2026-01-31T10:30:00.000Z', 'P1M', 'UTC')).toBe('2026-02-28T10:30:00.000Z');
  });

  it('reads nothing it cannot', () => {
    expect(shiftDate('soon', 'P1D', 'UTC')).toBeNull();
    expect(shiftDate('2026-01-01', 'a year', 'UTC')).toBeNull();
  });
});

describe('shiftDate in the org zone', () => {
  const LA = 'America/Los_Angeles';
  it('keeps the wall time across a DST change, in the value own style', () => {
    // 9:00 in Seattle on 1 Mar is 17:00Z; a month later the clocks have moved: 9:00 is 16:00Z.
    expect(shiftDate('2026-03-01T17:00:00Z', 'P1M', LA)).toBe('2026-04-01T16:00:00.000Z');
    expect(shiftDate('2026-03-01T09:00:00-08:00', 'P1M', LA)).toBe('2026-04-01T09:00:00-07:00');
    expect(shiftDate('2026-03-01T09:00', 'P1M', LA)).toBe('2026-04-01T09:00');
    expect(shiftDate('2026-03-07T23:30:00Z', 'P1D', LA)).toBe('2026-03-08T22:30:00.000Z');
  });

  it('moves a bare date as a calendar day in any zone', () => {
    expect(shiftDate('2026-03-07', 'P1D', LA)).toBe('2026-03-08');
    expect(shiftDate('2026-01-31', 'P1M', LA)).toBe('2026-02-28');
  });
});

describe('resolveOps', () => {
  it('keeps the touched values before and after', () => {
    const r = resolveOps(
      { gate: { set: 'B' }, points: { add: 5 }, note: { clear: true } },
      { gate: 'A', points: 10, note: 'x', other: 1 },
      'UTC',
    );
    expect(r).toEqual({
      ok: true,
      next: { gate: 'B', points: 15, other: 1 },
      from: { gate: 'A', points: 10, note: 'x' },
      to: { gate: 'B', points: 15, note: null },
    });
  });

  it('adds to an empty number as zero, and refuses a shift with nothing to shift', () => {
    expect(resolveOps({ points: { add: 3 } }, {}, 'UTC')).toMatchObject({
      ok: true,
      to: { points: 3 },
    });
    expect(resolveOps({ expires: { shift: 'P1D' } }, {}, 'UTC')).toEqual({
      ok: false,
      code: 'NO_VALUE',
    });
    expect(resolveOps({ expires: { shift: 'P1D' } }, { expires: 'soon' }, 'UTC')).toEqual({
      ok: false,
      code: 'NOT_A_DATE',
    });
    expect(resolveOps({ points: { add: 1 } }, { points: 'many' }, 'UTC')).toEqual({
      ok: false,
      code: 'NOT_A_NUMBER',
    });
  });
});

describe('the text', () => {
  it('finds tokens and fills them, keeping a literal percent sign', () => {
    expect(tokensOf('Hi {Plan}, {Gate}')).toEqual(['Plan', 'Gate']);
    expect(fillTokens('Plan {Plan} at 100%', (l) => (l === 'Plan' ? 'Gold' : null))).toBe(
      'Plan Gold at 100%% %@',
    );
  });
});

describe('changeOpsOf', () => {
  it('reads an op, a plain value and a bad op', () => {
    const { ops, issues } = changeOpsOf({
      a: { shift: 'P1Y' },
      b: 'x',
      c: { other: 1 },
      d: { shift: 'later' },
    });
    expect(ops).toEqual({ a: { shift: 'P1Y' }, b: { set: 'x' }, c: { set: { other: 1 } } });
    expect(issues).toEqual([{ key: 'd', message: 'Use a duration like P1Y or P30D.' }]);
  });
});
