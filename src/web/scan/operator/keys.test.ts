import { describe, expect, it } from 'vitest';
import { type KeyContext, type KeyInput, resolveKey, SHORTCUTS } from './keys.ts';

const key = (over: Partial<KeyInput> & { key: string }): KeyInput => ({
  code: '',
  alt: false,
  ctrl: false,
  meta: false,
  shift: false,
  composing: false,
  ...over,
});
const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
  zone: 'record',
  interactive: false,
  views: ['activity', 'problems'],
  fieldText: false,
  record: true,
  rollCall: false,
  walkIn: false,
  undoable: true,
  ...over,
});
const cmd = (k: KeyInput, c: KeyContext) => resolveKey(k, c)?.command;

describe('the search field', () => {
  const field = ctx({ zone: 'search' });
  it('moves the highlight, opens, and clears before it leaves', () => {
    expect(cmd(key({ key: 'ArrowDown' }), field)).toEqual({ c: 'move', by: 1 });
    expect(cmd(key({ key: 'ArrowUp' }), field)).toEqual({ c: 'move', by: -1 });
    expect(cmd(key({ key: 'Enter' }), field)).toEqual({ c: 'open' });
    expect(cmd(key({ key: 'Escape' }), { ...field, fieldText: true })).toEqual({ c: 'clear' });
    expect(cmd(key({ key: 'Escape' }), field)).toEqual({ c: 'blur-field' });
  });
  it('leaves letters to the field: o and n are text here', () => {
    expect(resolveKey(key({ key: 'o' }), field)).toBeNull();
    expect(resolveKey(key({ key: '/' }), field)).toBeNull();
    expect(resolveKey(key({ key: '?' }), field)).toBeNull();
  });
});

describe('the record zone', () => {
  it('Enter is the primary action unless the target takes Enter itself', () => {
    expect(cmd(key({ key: 'Enter' }), ctx())).toEqual({ c: 'primary' });
    expect(resolveKey(key({ key: 'Enter' }), ctx({ interactive: true }))).toBeNull();
    expect(resolveKey(key({ key: 'Enter' }), ctx({ record: false }))).toBeNull();
  });
  it('Esc closes the record', () => {
    expect(cmd(key({ key: 'Escape' }), ctx())).toEqual({ c: 'close-record' });
    expect(resolveKey(key({ key: 'Escape' }), ctx({ record: false }))).toBeNull();
  });
  it('letters act on the open record and wait out the quiet gap', () => {
    for (const [k, c] of [
      ['o', 'out'],
      ['n', 'note'],
      ['p', 'photo'],
    ] as const) {
      expect(resolveKey(key({ key: k }), ctx())).toMatchObject({ command: { c }, deferred: true });
    }
    expect(resolveKey(key({ key: 's' }), ctx())).toMatchObject({ command: { c: 'type' } });
    expect(cmd(key({ key: 's' }), ctx({ rollCall: true }))).toEqual({ c: 'safe' });
    expect(cmd(key({ key: 'x' }), ctx({ rollCall: true }))).toEqual({ c: 'gone' });
  });
  it('with no record open, a letter is type-to-search', () => {
    expect(resolveKey(key({ key: 'o' }), ctx({ record: false }))).toMatchObject({
      command: { c: 'type', ch: 'o' },
      deferred: true,
      prevent: false,
    });
  });
  it('/ and ? are deferred too, so a code that starts with them is a scan', () => {
    expect(resolveKey(key({ key: '/' }), ctx())).toMatchObject({
      command: { c: 'focus-search' },
      deferred: true,
    });
    expect(resolveKey(key({ key: '?', shift: true }), ctx())).toMatchObject({
      command: { c: 'help' },
      deferred: true,
    });
  });
});

describe('chords act at once, from any zone', () => {
  it.each(['search', 'text', 'record'] as const)('in %s', (zone) => {
    const c = ctx({ zone });
    expect(cmd(key({ key: 'k', meta: true }), c)).toEqual({ c: 'focus-search' });
    expect(cmd(key({ key: 'K', ctrl: true }), c)).toEqual({ c: 'focus-search' });
    expect(cmd(key({ key: 'z', meta: true }), c)).toEqual({ c: 'undo' });
    expect(cmd(key({ key: '2', code: 'Digit2', alt: true }), c)).toEqual({
      c: 'view',
      view: 'problems',
    });
  });
  it('leaves ⌘Z to the browser when there is nothing to undo', () => {
    expect(resolveKey(key({ key: 'z', meta: true }), ctx({ undoable: false }))).toBeNull();
    expect(resolveKey(key({ key: 'z', meta: true, shift: true }), ctx())).toBeNull();
  });
  it('⌥N is the walk-in only when there is one; ⌥3 needs a third list', () => {
    expect(resolveKey(key({ key: 'ñ', code: 'KeyN', alt: true }), ctx())).toBeNull();
    expect(cmd(key({ key: 'ñ', code: 'KeyN', alt: true }), ctx({ walkIn: true }))).toEqual({
      c: 'walk-in',
    });
    expect(resolveKey(key({ key: '3', code: 'Digit3', alt: true }), ctx())).toBeNull();
  });
});

describe('a text control keeps its keys', () => {
  it('nothing but a chord fires from a note', () => {
    const note = ctx({ zone: 'text' });
    for (const k of ['o', 'n', '/', '?', 'Enter', 'Escape', 'ArrowDown'])
      expect(resolveKey(key({ key: k }), note)).toBeNull();
  });
  it('ignores a key mid-composition', () => {
    expect(resolveKey(key({ key: 'k', meta: true, composing: true }), ctx())).toBeNull();
  });
});

describe('the sheet', () => {
  it('lists each shortcut once, from the same table', () => {
    const ids = SHORTCUTS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['scan', 'search', 'undo', 'help', 'primary']));
  });
});
