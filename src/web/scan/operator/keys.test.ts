import { describe, expect, it } from 'vitest';
import { type KeyContext, type KeyInput, keyLabel, resolveKey, SHORTCUTS } from './keys.ts';

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
  platform: 'mac',
  textHere: false,
  typingRecently: false,
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
    expect(cmd(key({ key: 'K', ctrl: true }), { ...c, platform: 'win' })).toEqual({
      c: 'focus-search',
    });
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

describe('Space belongs to the control that has it (H3)', () => {
  it('is never the start of a search, on a button, a row or the page', () => {
    for (const interactive of [true, false])
      expect(resolveKey(key({ key: ' ', code: 'Space' }), ctx({ interactive }))).toBeNull();
  });
  it('a letter on a focused row still starts a search', () => {
    expect(resolveKey(key({ key: 'm' }), ctx({ interactive: true, record: false }))).toMatchObject({
      command: { c: 'type', ch: 'm' },
    });
  });
});

describe('Enter after a slow reader (M1)', () => {
  it('is not the primary action when keys came a moment ago', () => {
    expect(resolveKey(key({ key: 'Enter' }), ctx({ typingRecently: true }))).toBeNull();
    expect(cmd(key({ key: 'Enter' }), ctx({ typingRecently: false }))).toEqual({ c: 'primary' });
  });
});

describe("⌘Z is a text control's own undo while it has text (M2)", () => {
  const z = key({ key: 'z', meta: true });
  it('leaves it to the browser in the field and a note when they hold text', () => {
    expect(resolveKey(z, ctx({ zone: 'search', textHere: true }))).toBeNull();
    expect(resolveKey(z, ctx({ zone: 'text', textHere: true }))).toBeNull();
  });
  it('undoes the scan from an empty field or the record', () => {
    expect(cmd(z, ctx({ zone: 'search' }))).toEqual({ c: 'undo' });
    expect(cmd(z, ctx({ zone: 'record', textHere: true }))).toEqual({ c: 'undo' });
  });
});

describe('modifiers by platform (L5)', () => {
  it('Ctrl is the modifier off a Mac, and Ctrl+Z does nothing on one', () => {
    expect(cmd(key({ key: 'k', ctrl: true }), ctx({ platform: 'win' }))).toEqual({
      c: 'focus-search',
    });
    expect(resolveKey(key({ key: 'k', meta: true }), ctx({ platform: 'win' }))).toBeNull();
    expect(resolveKey(key({ key: 'z', ctrl: true }), ctx({ platform: 'mac' }))).toBeNull();
  });
  it('Linux needs Shift with Alt, so tab switching keeps Alt+digit', () => {
    const alt2 = key({ key: '2', code: 'Digit2', alt: true });
    expect(resolveKey(alt2, ctx({ platform: 'linux' }))).toBeNull();
    expect(cmd({ ...alt2, shift: true }, ctx({ platform: 'linux' }))).toEqual({
      c: 'view',
      view: 'problems',
    });
    expect(cmd(alt2, ctx({ platform: 'win' }))).toEqual({ c: 'view', view: 'problems' });
  });
  it('labels follow', () => {
    expect(keyLabel('⌘Z', 'win')).toBe('Ctrl+Z');
    expect(keyLabel('⌥1', 'linux')).toBe('Alt+Shift+1');
    expect(keyLabel('⌘K', 'mac')).toBe('⌘K');
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
