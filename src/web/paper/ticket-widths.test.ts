import { describe, expect, it } from 'vitest';
import { bandFit } from './ticket-fit.ts';
import { fitWidths, widestIndex } from './ticket-widths.ts';

describe('fitWidths', () => {
  it('shares the slack equally when everything fits', () => {
    expect(fitWidths([10, 20], 50)).toEqual([20, 30]);
  });

  it('shrinks only the widest when the row is too long', () => {
    const w = fitWidths([12, 14, 80], 60);
    expect(w[0]).toBe(12);
    expect(w[1]).toBe(14);
    expect(w[2]).toBeCloseTo(34);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(60);
  });

  it('caps several wide boxes to one width', () => {
    expect(fitWidths([10, 50, 70], 80)).toEqual([10, 35, 35]);
  });

  it('names the widest text', () => {
    expect(widestIndex(['a', 'bbbb', 'cc'])).toBe(1);
  });
});

describe('bandFit', () => {
  it('keeps the title clear of the logo: fewer lines or a smaller size on a short band', () => {
    const tall = bandFit('A'.repeat(70), 67, 44);
    const half = bandFit('A'.repeat(70), 67, 38);
    expect(tall.lines).toBeLessThanOrEqual(2);
    expect(half.lines * half.size * 1.08).toBeLessThanOrEqual(38 - 2 * 5.5 - 9 - 2 - 4 + 1);
  });
});
