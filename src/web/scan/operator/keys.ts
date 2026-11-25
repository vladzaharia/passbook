/**
 * The operator's shortcut map. A pure resolver: a key, the focus zone and what is open in, a
 * command out. Nothing here touches the DOM, so every row of the map is testable and the `?`
 * sheet is drawn from the same table.
 */

export type OperatorView = 'activity' | 'problems' | 'inside';

/** Where focus is: the command field, another text control (a note), or anywhere else. */
export type Zone = 'search' | 'text' | 'record';

export type Command =
  | { c: 'focus-search' }
  | { c: 'clear' }
  | { c: 'blur-field' }
  | { c: 'close-record' }
  | { c: 'move'; by: 1 | -1 }
  | { c: 'open' }
  | { c: 'primary' }
  | { c: 'out' }
  | { c: 'note' }
  | { c: 'photo' }
  | { c: 'safe' }
  | { c: 'gone' }
  | { c: 'undo' }
  | { c: 'view'; view: OperatorView }
  | { c: 'walk-in' }
  | { c: 'help' }
  | { c: 'type'; ch: string };

export interface KeyInput {
  key: string;
  code: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  composing: boolean;
}

export type Platform = 'mac' | 'win' | 'linux';

export function detectPlatform(): Platform {
  const p = typeof navigator === 'undefined' ? '' : navigator.platform;
  return /Mac|iPhone|iPad/.test(p) ? 'mac' : /Linux|X11/.test(p) ? 'linux' : 'win';
}

/** Shortcut text for this platform: ⌘ is Ctrl off a Mac, ⌥ is Alt (Alt+Shift on Linux, where Alt+digit switches tabs). */
export function keyLabel(text: string, platform: Platform = detectPlatform()): string {
  if (platform === 'mac') return text;
  return text.replace('⌘', 'Ctrl+').replace('⌥', platform === 'linux' ? 'Alt+Shift+' : 'Alt+');
}

export interface KeyContext {
  platform: Platform;
  /** The focused control holds text, so ⌘Z there is its own undo. */
  textHere: boolean;
  /** A printable key came in the last 250 ms: an Enter now may be the end of a slow reader's code. */
  typingRecently: boolean;
  zone: Zone;
  /** The key's target takes Enter itself: a button, link, tab, option or menu item. */
  interactive: boolean;
  /** The views that exist, in tab order: ⌥1 is the first. */
  views: readonly OperatorView[];
  fieldText: boolean;
  record: boolean;
  rollCall: boolean;
  walkIn: boolean;
  /** This device has a scan it may undo now. */
  undoable: boolean;
}

export interface Resolved {
  command: Command;
  /** A bare character: it waits out the quiet gap, so a reader's burst can claim it first. */
  deferred: boolean;
  /** The browser's own handling of the key is cancelled. */
  prevent: boolean;
}

const now = (command: Command, prevent = true): Resolved => ({ command, deferred: false, prevent });
const later = (command: Command, prevent = true): Resolved => ({
  command,
  deferred: true,
  prevent,
});

/** A character a reader's keys can produce: one printable key, no chord. */
export function isPrintable(k: KeyInput): boolean {
  return k.key.length === 1 && !k.ctrl && !k.meta && !k.alt;
}

function chord(k: KeyInput, c: KeyContext): Resolved | null {
  const mod = c.platform === 'mac' ? k.meta : k.ctrl;
  const stray = c.platform === 'mac' ? k.ctrl : k.meta;
  const letter = k.key.toLowerCase();
  if (stray) return null;
  if (mod && !k.alt) {
    if (letter === 'k') return now({ c: 'focus-search' });
    // A text control keeps its own undo; with nothing to undo the browser keeps ⌘Z too.
    if (letter === 'z' && !k.shift)
      return c.undoable && (c.zone === 'record' || !c.textHere) ? now({ c: 'undo' }) : null;
    return null;
  }
  const alt = k.alt && !mod && (c.platform !== 'linux' || k.shift);
  if (alt) {
    if (k.code === 'KeyN') return c.walkIn ? now({ c: 'walk-in' }) : null;
    const digit = /^Digit([1-9])$/.exec(k.code);
    const view = digit ? c.views[Number(digit[1]) - 1] : undefined;
    return view ? now({ c: 'view', view }) : null;
  }
  return null;
}

function inField(k: KeyInput, c: KeyContext): Resolved | null {
  if (k.key === 'Escape') return now({ c: c.fieldText ? 'clear' : 'blur-field' });
  if (k.key === 'ArrowDown') return now({ c: 'move', by: 1 });
  if (k.key === 'ArrowUp') return now({ c: 'move', by: -1 });
  if (k.key === 'Enter') return now({ c: 'open' });
  return null;
}

function inRecord(k: KeyInput, c: KeyContext): Resolved | null {
  if (k.key === 'Escape') return c.record ? now({ c: 'close-record' }) : null;
  if (k.key === 'Enter')
    return c.record && !c.interactive && !c.typingRecently ? now({ c: 'primary' }) : null;
  if (!isPrintable(k)) return null;
  // Space is a button's key and a page's scroll: never the start of a search.
  if (k.key === ' ') return null;
  const letter = k.key.toLowerCase();
  if (k.key === '/') return later({ c: 'focus-search' });
  if (k.key === '?') return later({ c: 'help' });
  if (c.record && !k.shift) {
    if (letter === 'o') return later({ c: 'out' }, false);
    if (letter === 'n') return later({ c: 'note' });
    if (letter === 'p') return later({ c: 'photo' });
    if (c.rollCall && letter === 's') return later({ c: 'safe' }, false);
    if (c.rollCall && letter === 'x') return later({ c: 'gone' }, false);
  }
  return later({ c: 'type', ch: k.key }, false);
}

export function resolveKey(k: KeyInput, c: KeyContext): Resolved | null {
  if (k.composing) return null;
  const chorded = chord(k, c);
  if (chorded || k.ctrl || k.meta || k.alt) return chorded;
  if (c.zone === 'text') return null;
  return c.zone === 'search' ? inField(k, c) : inRecord(k, c);
}

export interface ShortcutRow {
  id: string;
  group: 'find' | 'record' | 'lists' | 'anywhere';
  keys: readonly string[];
  label: string;
  /** Shown only when the key does something here. */
  when?: 'record' | 'rollCall' | 'views' | 'walkIn';
}

/** What the `?` sheet lists. `⌘` is drawn as Ctrl off a Mac. */
export const SHORTCUTS: readonly ShortcutRow[] = [
  { id: 'scan', group: 'anywhere', keys: ['Scan'], label: 'Scan a code, from anywhere' },
  { id: 'search', group: 'find', keys: ['/', '⌘K'], label: 'Search' },
  { id: 'move', group: 'find', keys: ['↑', '↓'], label: 'Move' },
  { id: 'open', group: 'find', keys: ['↵'], label: 'Open, or scan a typed code' },
  { id: 'clear', group: 'find', keys: ['Esc'], label: 'Clear, then leave the field' },
  { id: 'walk-in', group: 'find', keys: ['⌥N'], label: 'Add a walk-in', when: 'walkIn' },
  { id: 'primary', group: 'record', keys: ['↵'], label: 'Primary action', when: 'record' },
  { id: 'out', group: 'record', keys: ['O'], label: 'Mark out', when: 'record' },
  { id: 'note', group: 'record', keys: ['N'], label: 'Add a note', when: 'record' },
  { id: 'photo', group: 'record', keys: ['P'], label: 'Add a photo', when: 'record' },
  { id: 'safe', group: 'record', keys: ['S'], label: 'Safe', when: 'rollCall' },
  { id: 'gone', group: 'record', keys: ['X'], label: 'Out', when: 'rollCall' },
  { id: 'close', group: 'record', keys: ['Esc'], label: 'Close person', when: 'record' },
  { id: 'views', group: 'lists', keys: ['⌥1', '⌥2'], label: 'Switch list', when: 'views' },
  { id: 'undo', group: 'anywhere', keys: ['⌘Z'], label: 'Undo last' },
  { id: 'help', group: 'anywhere', keys: ['?'], label: 'This sheet' },
];
