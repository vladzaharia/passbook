import { describe, expect, it } from 'vitest';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import type { BehaviorContext, PassJson } from '../../types.ts';
import { firstScanInput, type TermConfig, term } from './index.ts';

const ctx = (now = '2030-01-01T00:00:00Z'): BehaviorContext => ({
  now: new Date(now),
  identity: { passTypeIdentifier: 'p', teamIdentifier: 't' },
  lookups: {},
});
const run = (
  input: Record<string, unknown>,
  config: TermConfig,
  now?: string,
  base: Partial<PassJson> = {},
) => {
  const pass = { ...base } as PassJson;
  term.apply(pass, input as never, config, ctx(now));
  return pass;
};
const months = (length: number): TermConfig => ({ start: 's', unit: 'months', length });

describe('term', () => {
  it('adds calendar months', () => {
    expect(run({ s: '2030-03-15T10:00:00Z' }, months(12)).expirationDate).toBe(
      '2031-03-15T10:00:00Z',
    );
  });

  it('keeps 12 months from 31 Jan on 31 Jan and clamps short months', () => {
    expect(run({ s: '2030-01-31T10:00:00Z' }, months(12)).expirationDate).toBe(
      '2031-01-31T10:00:00Z',
    );
    expect(run({ s: '2030-01-31T10:00:00Z' }, months(1)).expirationDate).toBe(
      '2030-02-28T10:00:00Z',
    );
  });

  it('ends at month end, with a length of further months', () => {
    const c = (length: number): TermConfig => ({ start: 's', unit: 'month-end', length });
    expect(run({ s: '2030-04-10T08:00:00Z' }, c(1)).expirationDate).toBe('2030-04-30T23:59:59Z');
    expect(run({ s: '2030-04-10T08:00:00Z' }, c(3)).expirationDate).toBe('2030-06-30T23:59:59Z');
    expect(run({ s: '2030-12-31T08:00:00Z' }, c(2)).expirationDate).toBe('2031-01-31T23:59:59Z');
  });

  it('handles the leap day', () => {
    expect(run({ s: '2028-02-29T10:00:00Z' }, months(12)).expirationDate).toBe(
      '2029-02-28T10:00:00Z',
    );
    expect(
      run({ s: '2028-02-29T10:00:00Z' }, { start: 's', unit: 'years', length: 4 }).expirationDate,
    ).toBe('2032-02-29T10:00:00Z');
    expect(
      run({ s: '2028-02-01T00:00:00Z' }, { start: 's', unit: 'month-end', length: 1 })
        .expirationDate,
    ).toBe('2028-02-29T23:59:59Z');
  });

  it('keeps wall-clock time across a DST change', () => {
    const tz = 'America/New_York';
    // 10:00 EST (15:00Z) in January, 6 months on is 10:00 EDT (14:00Z).
    expect(run({ s: '2030-01-15T15:00:00Z' }, { ...months(6), timeZone: tz }).expirationDate).toBe(
      '2030-07-15T14:00:00Z',
    );
    // Days are calendar days too: 24h later would be 11:00 local across the jump.
    expect(
      run({ s: '2030-03-09T15:00:00Z' }, { start: 's', unit: 'days', length: 1, timeZone: tz })
        .expirationDate,
    ).toBe('2030-03-10T14:00:00Z');
  });

  it('ends at the close of the local day, not the UTC day', () => {
    const c: TermConfig = { ...months(1), timeZone: 'Asia/Tokyo', endOfDay: true };
    expect(run({ s: '2030-05-10T00:00:00Z' }, c).expirationDate).toBe('2030-06-10T14:59:59Z');
    expect(
      run(
        { s: '2030-03-10T12:00:00Z' },
        { start: 's', unit: 'month-end', length: 1, timeZone: 'America/New_York' },
      ).expirationDate,
    ).toBe('2030-04-01T03:59:59Z');
  });

  it('starts at build time when no start input is set', () => {
    expect(run({}, { unit: 'months', length: 12 }).expirationDate).toBe('2031-01-01T00:00:00Z');
  });

  it('has no end until the first scan stamps the start', () => {
    const pass = run({}, months(12), undefined, { expirationDate: '2099-01-01T00:00:00Z' });
    expect(pass.expirationDate).toBeUndefined();
    expect(run({ s: '2030-06-02T09:30:00Z' }, months(12)).expirationDate).toBe(
      '2031-06-02T09:30:00Z',
    );
  });

  it('renews from the current end, not from today', () => {
    const c: TermConfig = { ...months(12), renewals: 'n' };
    // Renewed early (now is mid-term): the second term starts where the first ends.
    expect(
      run({ s: '2030-03-15T10:00:00Z', n: '1' }, c, '2030-09-01T00:00:00Z').expirationDate,
    ).toBe('2032-03-15T10:00:00Z');
    expect(run({ s: '2030-03-15T10:00:00Z', n: 0 }, c).expirationDate).toBe('2031-03-15T10:00:00Z');
    // Anchored on the start day: no drift through short months.
    expect(
      run({ s: '2030-01-31T00:00:00Z', n: '1' }, { ...months(1), renewals: 'n' }).expirationDate,
    ).toBe('2030-03-31T00:00:00Z');
    expect(() =>
      run({ s: '2030-01-31T00:00:00Z', n: 'x' }, { ...months(1), renewals: 'n' }),
    ).toThrow(/not a count/);
  });

  it('supports terms over a year, up to ten', () => {
    expect(
      run({ s: '2030-03-15T10:00:00Z' }, { start: 's', unit: 'years', length: 5 }).expirationDate,
    ).toBe('2035-03-15T10:00:00Z');
    expect(run({ s: '2030-03-15T10:00:00Z' }, months(30)).expirationDate).toBe(
      '2032-09-15T10:00:00Z',
    );
    expect(
      run({ s: '2030-03-15T10:00:00Z' }, { start: 's', unit: 'days', length: 800 }).expirationDate,
    ).toBe('2032-05-23T10:00:00Z');
    expect(() =>
      run({ s: '2030-03-15T10:00:00Z' }, { start: 's', unit: 'years', length: 11 }),
    ).toThrow(/over ten years/);
  });

  it('adds grace days', () => {
    expect(run({ s: '2030-03-15T10:00:00Z' }, { ...months(1), graceDays: 7 }).expirationDate).toBe(
      '2030-04-22T10:00:00Z',
    );
  });

  it('voids a lapsed pass only when asked, and the scanner check follows', () => {
    const input = { s: '2029-01-10T00:00:00Z' };
    expect(run(input, months(1)).voided).toBeUndefined();
    const pass = run(input, { ...months(1), voidWhenPast: true });
    expect(pass.voided).toBe(true);
    const lapsed = run(input, months(1));
    expect(validityOf(lapsed, ctx().now).status).toBe('expired');
    const live = run({ s: '2029-12-20T00:00:00Z' }, months(1));
    expect(validityOf(live, ctx().now).status).toBe('active');
    expect(validityOf(live, new Date('2030-01-21T00:00:00Z')).status).toBe('expired');
  });

  it('throws on bad dates and zones', () => {
    expect(() => run({ s: 'soon' }, months(1))).toThrow(/not a date/);
    expect(() =>
      run({ s: '2030-01-01T00:00:00Z' }, { ...months(1), timeZone: 'Mars/Base' }),
    ).toThrow(/not a time zone/);
  });

  it('names the input a first-scan term waits on', () => {
    const use = (config: TermConfig) => ({ behaviors: [{ use: 'term', version: 1, config }] });
    expect(firstScanInput(use({ ...months(12), firstScan: true }) as never)).toBe('s');
    expect(firstScanInput(use(months(12)) as never)).toBeNull();
    expect(firstScanInput({})).toBeNull();
    expect(() => run({}, { unit: 'months', length: 1, firstScan: true })).toThrow(/start input/);
  });
});
