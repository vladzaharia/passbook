import { describe, expect, it } from 'vitest';
import { deriveVisit, stayOf, type VisitFacts } from './derive.ts';

const H = 3_600_000;
const base: VisitFacts = {
  now: 10 * H,
  windowFrom: 9 * H,
  windowUntil: 17 * H,
  cancelled: false,
  arrivedAt: null,
  lastInAt: null,
  lastOutAt: null,
};

describe('deriveVisit', () => {
  it('is expected before an arrival, in the window or ahead of it', () => {
    expect(deriveVisit(base)).toEqual({ status: 'expected', at: null, autoOut: false });
    expect(deriveVisit({ ...base, now: 8 * H }).status).toBe('expected');
  });

  it('is a no-show once the window ends with no arrival', () => {
    expect(deriveVisit({ ...base, now: 17 * H + 1 }).status).toBe('no_show');
    expect(deriveVisit({ ...base, now: 17 * H }).status).toBe('expected');
  });

  it('is in from the first check-in', () => {
    expect(deriveVisit({ ...base, arrivedAt: 9.5 * H, lastInAt: 9.5 * H })).toEqual({
      status: 'in',
      at: 9.5 * H,
      autoOut: false,
    });
  });

  it('is out at the exit, and in again after a later check-in', () => {
    const out = { ...base, arrivedAt: 9 * H, lastInAt: 9 * H, lastOutAt: 12 * H };
    expect(deriveVisit(out)).toEqual({ status: 'out', at: 12 * H, autoOut: false });
    expect(deriveVisit({ ...out, lastInAt: 13 * H }).status).toBe('in');
  });

  it('reads as out at the window end when they are still in (auto check-out)', () => {
    const s = deriveVisit({ ...base, now: 20 * H, arrivedAt: 9 * H, lastInAt: 9 * H });
    expect(s).toEqual({ status: 'out', at: 17 * H, autoOut: true });
  });

  it('never ends a stay before it began when they arrive after the window', () => {
    const s = deriveVisit({ ...base, now: 20 * H, arrivedAt: 18 * H, lastInAt: 18 * H });
    expect(s).toMatchObject({ status: 'out', at: 18 * H, autoOut: true });
  });

  it('is cancelled over everything else', () => {
    const s = deriveVisit({ ...base, cancelled: true, arrivedAt: 9 * H, lastInAt: 9 * H });
    expect(s.status).toBe('cancelled');
  });
});

describe('stayOf', () => {
  it('is the time from arrival, or null without one', () => {
    expect(stayOf(9 * H, 10 * H)).toBe(H);
    expect(stayOf(null, 10 * H)).toBeNull();
    expect(stayOf(11 * H, 10 * H)).toBeNull();
  });
});
