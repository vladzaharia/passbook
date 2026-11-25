import { describe, expect, it } from 'vitest';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import type { BehaviorContext, PassJson } from '../../types.ts';
import { instantOf } from './calendar.ts';
import { renewedStart, stampInput, type TermConfig, term } from './index.ts';

const ctx = (now = '2030-01-01T00:00:00Z'): BehaviorContext => ({
  now: new Date(now),
  timeZone: 'UTC',
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
const ms = (iso: string) => Date.parse(iso);

describe('term', () => {
  it('uses the org zone, and Seattle time when the context has none', () => {
    const c: TermConfig = { start: 's', unit: 'month-end', length: 1 };
    const pass = {} as PassJson;
    term.apply(pass, { s: '2030-04-10T08:00:00Z' } as never, c, {
      ...ctx(),
      timeZone: undefined as never,
    });
    expect(pass.expirationDate).toBe('2030-05-01T06:59:59Z');
    expect(run({ s: '2030-04-10T08:00:00Z' }, c).expirationDate).toBe('2030-04-30T23:59:59Z');
  });

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
    expect(run({ s: '2030-01-15T15:00:00Z' }, { ...months(6), timeZone: tz }).expirationDate).toBe(
      '2030-07-15T14:00:00Z',
    );
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

  it('reads a date-only start as a local date in the zone', () => {
    const c: TermConfig = {
      start: 's',
      unit: 'month-end',
      length: 1,
      timeZone: 'America/New_York',
    };
    // 1 Mar local, not the evening of 28 Feb: the month ends 31 Mar at 23:59:59 EDT.
    expect(run({ s: '2030-03-01' }, c).expirationDate).toBe('2030-04-01T03:59:59Z');
    expect(run({ s: '2030-03-01' }, { ...months(1), timeZone: 'Asia/Tokyo' }).expirationDate).toBe(
      '2030-03-31T15:00:00Z',
    );
    expect(run({ s: '2030-03-01' }, months(1)).expirationDate).toBe('2030-04-01T00:00:00Z');
  });

  it('rejects dates that do not exist or predate 1970', () => {
    expect(() => run({ s: '2030-02-30' }, months(1))).toThrow(/not a date/);
    expect(() => run({ s: '2030-02-30T10:00:00Z' }, months(1))).toThrow(/not a date/);
    expect(() => run({ s: '0030-03-01' }, months(1))).toThrow(/not a date/);
    expect(() => run({ s: '1969-12-31T00:00:00Z' }, months(1))).toThrow(/not a date/);
  });

  it('puts a skipped local time after the jump, whatever the gap', () => {
    const wall = { y: 2030, mo: 3, d: 10, h: 2, mi: 30, s: 0 };
    // New York springs forward 02:00 to 03:00: 02:30 does not exist.
    expect(instantOf(wall, 'America/New_York')).toBe(ms('2030-03-10T07:30:00Z'));
    // Lord Howe's gap is 30 minutes: 02:15 (on 6 Oct 2030) does not exist; 02:30 is after it.
    const after = instantOf({ y: 2030, mo: 10, d: 6, h: 2, mi: 15, s: 0 }, 'Australia/Lord_Howe');
    expect(new Date(after).toISOString() >= '2030-10-05T15:30:00.000Z').toBe(true);
    expect(
      instantOf({ y: 2030, mo: 10, d: 6, h: 2, mi: 45, s: 0 }, 'Australia/Lord_Howe'),
    ).toBeGreaterThanOrEqual(after);
  });

  it('keeps the end of day after grace across a DST change', () => {
    const c: TermConfig = {
      start: 's',
      unit: 'month-end',
      length: 1,
      timeZone: 'America/New_York',
      graceDays: 7,
    };
    // 28 Feb close + 10 calendar days is 10 Mar 23:59:59, after the jump (EDT); adding 240h would be an hour off.
    expect(run({ s: '2030-03-01' }, { ...c, graceDays: 0 }).expirationDate).toBe(
      '2030-04-01T03:59:59Z',
    );
    expect(run({ s: '2030-03-01' }, c).expirationDate).toBe('2030-04-08T03:59:59Z');
    expect(run({ s: '2030-02-01' }, { ...c, graceDays: 10 }).expirationDate).toBe(
      '2030-03-11T03:59:59Z',
    );
  });

  it('has no end until the first scan stamps the start, and drops a template default', () => {
    const c: TermConfig = { ...months(12), startOn: 'first-scan' };
    const pass = run({}, c, undefined, { expirationDate: '2099-01-01T00:00:00Z' });
    expect(pass.expirationDate).toBeUndefined();
    expect(run({ s: '2030-06-02T09:30:00Z' }, c).expirationDate).toBe('2031-06-02T09:30:00Z');
  });

  it('leaves an existing expiry alone when the start is empty and no scan will stamp it', () => {
    const base = { expirationDate: '2099-01-01T00:00:00Z' };
    expect(run({}, months(12), undefined, base).expirationDate).toBe('2099-01-01T00:00:00Z');
    expect(run({}, { ...months(12), startOn: 'issue' }, undefined, base).expirationDate).toBe(
      '2099-01-01T00:00:00Z',
    );
  });

  it('an issue-time start never moves with the build time', () => {
    const c: TermConfig = { ...months(12), startOn: 'issue' };
    const input = { s: '2030-01-01T00:00:00Z' };
    expect(run(input, c, '2030-01-01T00:00:00Z').expirationDate).toBe('2031-01-01T00:00:00Z');
    expect(run(input, c, '2030-09-01T00:00:00Z').expirationDate).toBe('2031-01-01T00:00:00Z');
  });

  it('renews from the current end when early, and from the renewal when lapsed', () => {
    const c = months(12);
    const start = ms('2030-03-15T10:00:00Z');
    expect(renewedStart(start, c, ms('2030-09-01T00:00:00Z')).start).toBe(
      ms('2031-03-15T10:00:00Z'),
    );
    const lapsed = ms('2033-01-10T08:00:00Z');
    expect(renewedStart(start, c, lapsed)).toEqual({ start: lapsed, anchor: lapsed });
    expect(
      run(
        { s: new Date(renewedStart(start, c, lapsed).start).toISOString() },
        c,
        '2033-01-10T08:00:00Z',
        {},
      ).expirationDate,
    ).toBe('2034-01-10T08:00:00Z');
    expect(
      run(
        { s: new Date(renewedStart(start, c, lapsed).start).toISOString() },
        { ...c, voidWhenPast: true },
        '2033-01-10T08:00:00Z',
      ).voided,
    ).toBeUndefined();
    // A day-end term starts the next one at the following midnight.
    const eom: TermConfig = { start: 's', unit: 'month-end', length: 1, timeZone: 'UTC' };
    expect(renewedStart(ms('2030-04-10T08:00:00Z'), eom, ms('2030-04-12T00:00:00Z')).start).toBe(
      ms('2030-05-01T00:00:00Z'),
    );
  });

  it('keeps the day of the month through consecutive renewals', () => {
    const c: TermConfig = { start: 's', anchor: 'a', unit: 'months', length: 1, timeZone: 'UTC' };
    const endOf = (start: number, anchor?: number) =>
      run(
        {
          s: new Date(start).toISOString(),
          ...(anchor ? { a: new Date(anchor).toISOString() } : {}),
        },
        c,
      ).expirationDate;
    let state = { start: ms('2030-01-31T10:00:00Z'), anchor: undefined as number | undefined };
    const ends = [endOf(state.start)];
    for (let i = 0; i < 3; i++) {
      // Each renewal arrives early, before the term ends.
      const next = renewedStart(state.start, c, state.start + 1000, state.anchor);
      state = next;
      ends.push(endOf(state.start, state.anchor));
    }
    expect(ends).toEqual([
      '2030-02-28T10:00:00Z',
      '2030-03-31T10:00:00Z',
      '2030-04-30T10:00:00Z',
      '2030-05-31T10:00:00Z',
    ]);
  });

  it('re-anchors on a lapsed renewal', () => {
    const c: TermConfig = { start: 's', anchor: 'a', unit: 'months', length: 1, timeZone: 'UTC' };
    const lapsedAt = ms('2030-06-15T09:00:00Z');
    const r = renewedStart(ms('2030-01-31T10:00:00Z'), c, lapsedAt, ms('2030-01-31T10:00:00Z'));
    expect(r).toEqual({ start: lapsedAt, anchor: lapsedAt });
    expect(
      run({ s: new Date(r.start).toISOString(), a: new Date(r.anchor).toISOString() }, c)
        .expirationDate,
    ).toBe('2030-07-15T09:00:00Z');
  });

  it('caps one term at ten years, not the span of renewals', () => {
    const start = ms('2030-03-15T10:00:00Z');
    const yearly: TermConfig = { start: 's', unit: 'years', length: 1, timeZone: 'UTC' };
    let at = start;
    for (let i = 0; i < 12; i++) at = renewedStart(at, yearly, 0).start;
    expect(run({ s: new Date(at).toISOString() }, yearly).expirationDate).toBe(
      '2043-03-15T10:00:00Z',
    );
    expect(
      run({ s: '2030-03-15T10:00:00Z' }, { start: 's', unit: 'years', length: 10 }).expirationDate,
    ).toBe('2040-03-15T10:00:00Z');
    expect(() =>
      run({ s: '2030-03-15T10:00:00Z' }, { start: 's', unit: 'years', length: 11 }),
    ).toThrow(/over ten years/);
    expect(run({ s: '2030-03-15T10:00:00Z' }, months(30)).expirationDate).toBe(
      '2032-09-15T10:00:00Z',
    );
    expect(
      run({ s: '2030-03-15T10:00:00Z' }, { start: 's', unit: 'days', length: 800 }).expirationDate,
    ).toBe('2032-05-23T10:00:00Z');
  });

  it('adds grace days', () => {
    expect(run({ s: '2030-03-15T10:00:00Z' }, { ...months(1), graceDays: 7 }).expirationDate).toBe(
      '2030-04-22T10:00:00Z',
    );
  });

  it('voids a lapsed pass only when asked, and the scanner check follows', () => {
    const input = { s: '2029-01-10T00:00:00Z' };
    expect(run(input, months(1)).voided).toBeUndefined();
    expect(run(input, { ...months(1), voidWhenPast: true }).voided).toBe(true);
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

  it('names the input a scan or a publish stamps', () => {
    const use = (config: TermConfig) => ({ behaviors: [{ use: 'term', version: 1, config }] });
    expect(stampInput(use({ ...months(12), startOn: 'first-scan' }) as never, 'first-scan')).toBe(
      's',
    );
    expect(stampInput(use({ ...months(12), startOn: 'issue' }) as never, 'issue')).toBe('s');
    expect(stampInput(use({ ...months(12), startOn: 'issue' }) as never, 'first-scan')).toBeNull();
    expect(stampInput(use(months(12)) as never, 'issue')).toBeNull();
    expect(stampInput({}, 'issue')).toBeNull();
  });
});
