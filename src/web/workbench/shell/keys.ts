import type { WbTool } from '@/shared/workbench.ts';

/** `g` then a letter opens an area (design §5.4); `w` is Events too (webhooks). */
export const GO_KEYS: Readonly<Record<string, WbTool>> = {
  h: 'home',
  q: 'quickstart',
  d: 'design',
  p: 'passes',
  c: 'console',
  l: 'logs',
  e: 'events',
  w: 'events',
  i: 'inbox',
  a: 'activity',
  k: 'keys',
  s: 'sandbox',
};

/** The chord each area answers to, for `aria-keyshortcuts` and the shortcuts sheet. */
export const GO_CHORD: Readonly<Record<WbTool, string>> = {
  home: 'g h',
  quickstart: 'g q',
  design: 'g d',
  passes: 'g p',
  console: 'g c',
  logs: 'g l',
  events: 'g e',
  inbox: 'g i',
  activity: 'g a',
  keys: 'g k',
  sandbox: 'g s',
};

/** A `g` waits this long for its second key. */
export const CHORD_MS = 1200;

export type ShellAction =
  | { kind: 'go'; tool: WbTool }
  | { kind: 'help' }
  | { kind: 'palette' }
  | { kind: 'chord' };

export interface ShellKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/** Where a single key belongs to the control: fields, menus, dialogs, wizards, the designer canvas. */
const OWNS_KEYS = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[data-wizard]',
  '[data-designer-canvas]',
].join(', ');

export function ownsKeys(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return Boolean(el?.closest?.(OWNS_KEYS));
}

/**
 * The shell's action for one key. ⌘K toggles the palette and ⌘/ opens the sheet, anywhere. Single keys need the
 * switch on, no modifier, no open layer and a target that does not own them. Pure: the hook
 * keeps the chord and the layer state.
 */
export function resolveShellKey(
  e: ShellKey,
  state: { chord: boolean; singleKeys: boolean; layerOpen: boolean },
): { action: ShellAction | null; chord: boolean } {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') return { action: { kind: 'palette' }, chord: false };
  if (mod && e.key === '/') return { action: { kind: 'help' }, chord: false };
  if (!state.singleKeys || mod || e.altKey || state.layerOpen || ownsKeys(e.target))
    return { action: null, chord: false };
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (state.chord) {
    const tool = GO_KEYS[key];
    return { action: tool ? { kind: 'go', tool } : null, chord: false };
  }
  if (key === 'g') return { action: { kind: 'chord' }, chord: true };
  if (e.key === '?') return { action: { kind: 'help' }, chord: false };
  return { action: null, chord: false };
}
