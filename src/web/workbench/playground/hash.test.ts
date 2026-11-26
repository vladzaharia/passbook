import { describe, expect, it } from 'vitest';
import { DEFAULTS, decodeHash, encodeEdits, encodeHash, type PlaygroundState } from './hash.ts';

const FALLBACK = 'baked:starter-store-card';

describe('playground hash', () => {
  it('round-trips every field, including non-ASCII and nested edits', () => {
    const state: PlaygroundState = {
      template: 'baked:starter-event-ticket',
      edits: { eventName: 'Café “Nuit”', doorsOpen: true, seats: 3, tags: ['a', 'b'], note: null },
      channel: 'google',
      face: 'back',
      lang: 'go',
      mode: 'json',
    };
    expect(decodeHash(encodeHash(state), FALLBACK)).toEqual(state);
  });

  it('leaves defaults out, so the plain link is short', () => {
    const state: PlaygroundState = { template: FALLBACK, edits: {}, ...DEFAULTS };
    expect(encodeHash(state)).toBe(`#t=${encodeURIComponent(FALLBACK)}`);
    expect(decodeHash(encodeHash(state), 'other')).toEqual(state);
  });

  it('opens any link: empty, unknown values and a mangled edit block fall back', () => {
    expect(decodeHash('', FALLBACK)).toEqual({ template: FALLBACK, edits: {}, ...DEFAULTS });
    const odd = decodeHash('#c=nope&f=side&l=rust&m=xml&i=%%%', FALLBACK);
    expect(odd).toEqual({ template: FALLBACK, edits: {}, ...DEFAULTS });
  });

  it('drops keys that could poison an object, and edits that are not an object', () => {
    const poisoned = btoa('{"__proto__":{"x":1},"points":5}').replaceAll('=', '');
    expect(decodeHash(`#i=${poisoned}`, FALLBACK).edits).toEqual({ points: 5 });
    expect(Object.hasOwn(decodeHash(`#i=${poisoned}`, FALLBACK).edits, '__proto__')).toBe(false);
    expect(decodeHash(`#i=${encodeEdits([1, 2] as never)}`, FALLBACK).edits).toEqual({});
  });

  it('ignores a hash too long to be a person’s link', () => {
    expect(decodeHash(`#t=${'x'.repeat(13_000)}`, FALLBACK).template).toBe(FALLBACK);
  });
});
