import { describe, expect, it } from 'vitest';
import {
  copyDay,
  copyTargets,
  nextSpan,
  outsidePlan,
  setDay,
  spanProblem,
  spanText,
  weekProblems,
} from './hours.ts';

describe('span text', () => {
  it('reads 12-hour clocks and marks a span past midnight', () => {
    expect(spanText('06:00-16:00')).toBe('6 AM – 4 PM');
    expect(spanText('22:00-02:00')).toBe('10 PM – 2 AM (next day)');
    expect(spanText('00:00-24:00')).toBe('12 AM – 12 AM');
    expect(spanText('08:30-09:15')).toBe('8:30 AM – 9:15 AM');
  });

  it('names what is wrong with a span', () => {
    expect(spanProblem('06:00-06:00')).toBe('End must differ from start.');
    expect(spanProblem('06:00-')).toBe('Set both times.');
    expect(spanProblem('24:00-02:00')).toBe('Start before midnight.');
    expect(spanProblem('06:00-16:00')).toBeNull();
    expect(spanProblem('00:00-24:00')).toBeNull();
  });
});

describe('week problems', () => {
  it('finds overlapping spans on one day', () => {
    const problems = weekProblems({ mon: ['06:00-10:00', '09:00-12:00'] });
    expect(problems.mon).toBe('6 AM – 10 AM overlaps 9 AM – 12 PM.');
    expect(problems.tue).toBeUndefined();
  });

  it("counts yesterday's span past midnight", () => {
    const problems = weekProblems({ sun: ['22:00-02:00'], mon: ['01:00-03:00'] });
    expect(Object.keys(problems)).toEqual(['mon']);
  });

  it('lets touching spans through', () => {
    expect(weekProblems({ mon: ['06:00-10:00', '10:00-12:00'] })).toEqual({});
  });
});

describe('editing a week', () => {
  it('closes a day by giving it no spans, and the week by closing every day', () => {
    const one = setDay({ mon: ['09:00-17:00'] }, 'tue', ['10:00-12:00']);
    expect(one).toEqual({ mon: ['09:00-17:00'], tue: ['10:00-12:00'] });
    expect(setDay(one, 'tue', [])).toEqual({ mon: ['09:00-17:00'] });
    expect(setDay({ mon: ['09:00-17:00'] }, 'mon', [])).toBeUndefined();
  });

  it('copies a weekday to the other weekdays and a weekend day to its pair', () => {
    const hours = { mon: ['06:00-16:00', '20:00-23:00'], sat: ['08:00-20:00'] };
    expect(copyTargets('mon').label).toBe('weekdays');
    expect(copyDay(hours, 'mon')).toEqual({
      mon: hours.mon,
      tue: hours.mon,
      wed: hours.mon,
      thu: hours.mon,
      fri: hours.mon,
      sat: hours.sat,
    });
    expect(copyDay(hours, 'sat')).toEqual({ ...hours, sun: hours.sat });
  });

  it('starts a new span after the last one, or in the working day', () => {
    expect(nextSpan([])).toBe('09:00-17:00');
    expect(nextSpan(['06:00-10:00'])).toBe('10:00-12:00');
    expect(nextSpan(['06:00-23:00'])).toBe('22:00-24:00');
  });

  it('strikes a zone span that has no minute inside the plan', () => {
    const plan = { mon: ['06:00-10:00'], tue: ['22:00-02:00'] };
    expect(outsidePlan(plan, 'mon', '11:00-12:00')).toBe(true);
    expect(outsidePlan(plan, 'mon', '09:00-12:00')).toBe(false);
    expect(outsidePlan(plan, 'wed', '00:30-01:00')).toBe(false);
    expect(outsidePlan(undefined, 'mon', '11:00-12:00')).toBe(false);
  });
});
