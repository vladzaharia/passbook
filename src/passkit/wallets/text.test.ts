import { describe, expect, it } from 'vitest';
import { fits, fitText, isPlainText, lengthItem, measure, sanitizeText, shorten } from './text.ts';

describe('sanitizeText', () => {
  it('removes markup and controls and trims', () => {
    expect(sanitizeText('  <b>Hi</b>\u0000 there\u0085 ')).toBe('Hi  there');
    expect(sanitizeText('<a href="x">link</a> & <script>x</script>')).toBe('link & x');
    expect(sanitizeText('a\r\nb\rc\t d')).toBe('a\nb\nc  d');
    expect(sanitizeText('1 < 2 and 3 > 2')).toBe('1 < 2 and 3 > 2');
  });

  it('knows plain text', () => {
    expect(isPlainText('Gold member')).toBe(true);
    expect(isPlainText('')).toBe(false);
    expect(isPlainText('<i>x</i>')).toBe(false);
    expect(isPlainText('a\u0007b')).toBe(false);
    expect(isPlainText(' padded ')).toBe(false);
  });
});

describe('measure and shorten', () => {
  it('counts code points and bytes', () => {
    expect(measure('a😀é', 'chars')).toBe(3);
    expect(measure('a😀é', 'bytes')).toBe(7);
    expect(fits('abc', { unit: 'chars', max: 3 })).toBe(true);
    expect(fits('abcd', { unit: 'chars', max: 3 })).toBe(false);
  });

  it('returns fitting text as is', () => {
    expect(shorten('Hello', { unit: 'chars', max: 5 })).toEqual({
      text: 'Hello',
      shortened: false,
    });
  });

  it('ends a cut in an ellipsis within the limit', () => {
    expect(shorten('Hello world', { unit: 'chars', max: 8 })).toEqual({
      text: 'Hello w…',
      shortened: true,
    });
    expect(shorten('Hello world', { unit: 'chars', max: 7 }).text).toBe('Hello…');
  });

  it('cuts at a grapheme boundary', () => {
    const family = '👨‍👩‍👧'; // one grapheme, five code points
    const out = shorten(`${family}${family}${family}`, { unit: 'chars', max: 11 });
    expect(out.text).toBe(`${family}${family}…`);
    const flag = '🇳🇴';
    expect(shorten(`ab${flag}`, { unit: 'chars', max: 3 }).text).toBe('ab…');
    const accent = 'e\u0301'; // e + combining acute
    expect(shorten(`${accent}${accent}${accent}`, { unit: 'chars', max: 5 }).text).toBe(
      `${accent}${accent}…`,
    );
  });

  it('counts the ellipsis in bytes', () => {
    const out = shorten('abcdefghij', { unit: 'bytes', max: 6 });
    expect(out.text).toBe('abc…');
    expect(measure(out.text, 'bytes')).toBe(6);
    expect(shorten('ééééé', { unit: 'bytes', max: 7 }).text).toBe('éé…');
  });

  it('gives nothing when not even the ellipsis fits', () => {
    expect(shorten('abcdef', { unit: 'bytes', max: 2 })).toEqual({ text: '', shortened: true });
    expect(shorten('abcdef', { unit: 'chars', max: 0 })).toEqual({ text: '', shortened: true });
  });
});

describe('fitText: display is shortened, identity is never cut (Q20)', () => {
  const limit = { unit: 'chars', max: 5 } as const;
  it('shortens display text', () => {
    expect(fitText('abc', limit, 'display')).toEqual({ status: 'ok', text: 'abc' });
    expect(fitText('abcdefgh', limit, 'display')).toEqual({ status: 'shortened', text: 'abcd…' });
  });
  it('never touches an identity value', () => {
    expect(fitText('ABC-12345', limit, 'identity')).toEqual({
      status: 'too-long',
      text: 'ABC-12345',
    });
    expect(fitText('ABC-1', limit, 'identity')).toEqual({ status: 'ok', text: 'ABC-1' });
  });
});

describe('lengthItem', () => {
  const limit = { unit: 'chars', max: 10 } as const;
  const base = { path: 'primaryFields.name', limit };
  it('reports a value that was cut', () => {
    expect(lengthItem({ ...base, value: 'x'.repeat(11), declaredMax: 5 })).toEqual({
      capability: 'text.length',
      path: 'primaryFields.name',
      support: 'difference',
      message: 'Shortened to 10 characters.',
    });
  });
  it('says "may be shortened" for an unbounded or too generous input', () => {
    expect(lengthItem({ ...base, value: 'short' })?.message).toBe(
      'May be shortened to 10 characters.',
    );
    expect(lengthItem({ ...base, declaredMax: 80 })?.message).toBe(
      'May be shortened to 10 characters.',
    );
    expect(lengthItem({ path: 'p', limit: { unit: 'bytes', max: 9 } })?.message).toBe(
      'May be shortened to 9 bytes.',
    );
  });
  it('reports nothing for a bounded input that always fits', () => {
    expect(lengthItem({ ...base, value: 'short', declaredMax: 10 })).toBeNull();
  });
});
