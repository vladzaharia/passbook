import { describe, expect, it } from 'vitest';
import { charOf, fromKey, isAllowedChar } from './us-keymap.ts';

describe('us-keymap', () => {
  it('maps physical keys, not the layout: KeyY on a German layout is Y', () => {
    expect(charOf('KeyY', false)).toBe('y');
    expect(charOf('KeyY', true)).toBe('Y');
    expect(charOf('KeyZ', true)).toBe('Z');
  });

  it('maps digits, shifted digits and the numpad', () => {
    expect(charOf('Digit7', false)).toBe('7');
    expect(charOf('Digit7', true)).toBe('&');
    expect(charOf('Digit2', true)).toBe('@');
    expect(charOf('Numpad3', false)).toBe('3');
    expect(charOf('NumpadDecimal', false)).toBe('.');
  });

  it('maps punctuation with and without Shift', () => {
    expect(charOf('Minus', false)).toBe('-');
    expect(charOf('Minus', true)).toBe('_');
    expect(charOf('Slash', false)).toBe('/');
    expect(charOf('Semicolon', true)).toBe(':');
    expect(charOf('Period', false)).toBe('.');
    expect(charOf('Space', false)).toBe(' ');
    expect(charOf('Backquote', true)).toBe('~');
  });

  it('returns null for keys that are not characters', () => {
    expect(charOf('ArrowLeft', false)).toBeNull();
    expect(charOf('Escape', false)).toBeNull();
    expect(charOf('', false)).toBeNull();
  });

  it('falls back to event.key only for a single character', () => {
    expect(fromKey('a')).toBe('a');
    expect(fromKey('Enter')).toBeNull();
    expect(fromKey('é')).toBe('é');
  });

  it('allows the scan alphabet and flags the rest', () => {
    for (const ch of 'AZaz09-_.:/') expect(isAllowedChar(ch)).toBe(true);
    for (const ch of 'é§ü#') expect(isAllowedChar(ch)).toBe(false);
  });
});
