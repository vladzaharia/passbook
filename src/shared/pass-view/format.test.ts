import { describe, expect, it } from 'vitest';
import { formatValue, safeLocale, spellOut } from './format.ts';
import { parsePassStrings } from './strings.ts';

const ctx = { locale: 'en-US', now: new Date('2026-10-31T12:00:00Z'), timeZone: 'UTC' };

describe('dates', () => {
  it('applies date and time styles', () => {
    const f = formatValue('2026-03-01T15:30:00Z', { dateStyle: 'PKDateStyleMedium' }, ctx);
    expect(f.text).toBe('Mar 1, 2026');
    expect(f.dateTime).toBe('2026-03-01T15:30:00Z');
    expect(
      formatValue(
        '2026-03-01T15:30:00Z',
        { dateStyle: 'PKDateStyleNone', timeStyle: 'PKDateStyleShort' },
        ctx,
      ).text,
    ).toMatch(/3:30\sPM/);
  });

  it('leaves the string alone when both styles are none or absent', () => {
    expect(formatValue('2026-03-01T15:30:00Z', {}, ctx)).toEqual({ text: '2026-03-01T15:30:00Z' });
    expect(formatValue('x', { dateStyle: 'PKDateStyleNone' }, ctx).text).toBe('x');
  });

  it('honours the viewer time zone', () => {
    const tokyo = { ...ctx, timeZone: 'Asia/Tokyo' };
    expect(formatValue('2026-03-01T20:00:00Z', { dateStyle: 'PKDateStyleShort' }, tokyo).text).toBe(
      '3/2/26',
    );
  });

  it('ignoresTimeZone shows the written wall clock in any zone', () => {
    const spec = { timeStyle: 'PKDateStyleShort', ignoresTimeZone: true };
    for (const timeZone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      expect(formatValue('2026-03-01T09:05:00-05:00', spec, { ...ctx, timeZone }).text).toMatch(
        /9:05\sAM/,
      );
    }
  });

  it('formats relative dates', () => {
    const rel = (v: string, extra = {}) =>
      formatValue(v, { dateStyle: 'PKDateStyleShort', isRelative: true, ...extra }, ctx).text;
    expect(rel('2026-10-31T23:00:00Z')).toBe('today');
    expect(rel('2026-11-01T01:00:00Z')).toBe('tomorrow');
    expect(rel('2026-11-03T00:00:00Z')).toBe('in 3 days');
    expect(rel('2026-10-30T00:00:00Z')).toBe('yesterday');
    expect(rel('2026-10-31T14:00:00Z', { timeStyle: 'PKDateStyleShort' })).toBe('in 2 hours');
    expect(rel('2026-10-31T12:30:00Z', { timeStyle: 'PKDateStyleShort' })).toBe('in 30 minutes');
  });

  it('warns on an unparsable date and keeps the raw value', () => {
    expect(formatValue('not a date', { dateStyle: 'PKDateStyleShort' }, ctx)).toEqual({
      text: 'not a date',
      warning: 'field.date.invalid',
    });
  });

  it('localizes output', () => {
    expect(
      formatValue(
        '2026-03-01T00:00:00Z',
        { dateStyle: 'PKDateStyleLong' },
        { ...ctx, locale: 'de' },
      ).text,
    ).toBe('1. März 2026');
  });
});

describe('numbers', () => {
  it('formats currency, decimal, percent, scientific', () => {
    expect(formatValue(23.5, { currencyCode: 'USD' }, ctx).text).toBe('$23.50');
    expect(formatValue(1234567, { numberStyle: 'PKNumberStyleDecimal' }, ctx).text).toBe(
      '1,234,567',
    );
    expect(formatValue(0.25, { numberStyle: 'PKNumberStylePercent' }, ctx).text).toBe('25%');
    expect(formatValue(12345, { numberStyle: 'PKNumberStyleScientific' }, ctx).text).toMatch(
      /1\.2345E4/,
    );
  });

  it('localizes currency', () => {
    expect(formatValue(1234.5, { currencyCode: 'EUR' }, { ...ctx, locale: 'de-DE' }).text).toMatch(
      /1\.234,50\s€/,
    );
  });

  it('formats numeric strings when a number style is set', () => {
    expect(formatValue('1500', { numberStyle: 'PKNumberStyleDecimal' }, ctx).text).toBe('1,500');
    expect(formatValue('abc', { numberStyle: 'PKNumberStyleDecimal' }, ctx).text).toBe('abc');
  });

  it('warns on a bad currency code', () => {
    expect(formatValue(5, { currencyCode: 'nope!' }, ctx)).toEqual({
      text: '5',
      warning: 'field.currency.invalid',
    });
  });

  it('spells out numbers', () => {
    expect(spellOut(0)).toBe('zero');
    expect(spellOut(21)).toBe('twenty-one');
    expect(spellOut(1200)).toBe('one thousand two hundred');
    expect(spellOut(-7)).toBe('minus seven');
    expect(spellOut(2_000_000)).toBe('two million');
    expect(spellOut(1.5)).toBeUndefined();
    expect(formatValue(1.5, { numberStyle: 'PKNumberStyleSpellOut' }, ctx).warning).toBe(
      'field.spellout.range',
    );
  });

  it('plain numbers and other types pass through', () => {
    expect(formatValue(7, {}, ctx).text).toBe('7');
    expect(formatValue(true, {}, ctx).text).toBe('true');
    expect(formatValue(null, {}, ctx).text).toBe('');
    expect(formatValue({ a: 1 }, {}, ctx).text).toBe('');
  });
});

describe('locale', () => {
  it('canonicalizes and falls back', () => {
    expect(safeLocale('pt_BR')).toEqual({ locale: 'pt-BR', bad: false });
    expect(safeLocale(undefined)).toEqual({ locale: 'en', bad: false });
    expect(safeLocale('!!')).toEqual({ locale: 'en', bad: true });
  });
});

describe('parsePassStrings', () => {
  it('parses pairs, escapes, comments', () => {
    const out = parsePassStrings(
      `/* c */\n// x\n"A" = "Hello \\"you\\"\\n";\n"B\\u00e9" = "caf\\u00e9";`,
    );
    expect(out).toEqual({ A: 'Hello "you"\n', Bé: 'café' });
  });

  it('returns {} for garbage', () => {
    expect(parsePassStrings('nothing here')).toEqual({});
  });
});
