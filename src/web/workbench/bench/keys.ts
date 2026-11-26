import { useEffect, useRef } from 'react';
import { singleKeysOn } from '../shell/prefs.ts';
import { typing } from './typing.ts';

/** What a key does in a bench list (design §5.4). Tools bind the ones they have; `g` chords and `?` are the shell's. */
export type BenchAction = 'next' | 'prev' | 'open' | 'close' | 'primary' | 'copyId' | 'copyCurl';

export interface BenchKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

const SINGLE: Record<string, BenchAction> = {
  j: 'next',
  k: 'prev',
  y: 'copyId',
  c: 'copyCurl',
};
/** A focused control keeps Enter: it is a key for it, not the bench. */
const CONTROL = 'a[href], button, input, select, textarea, summary, [role="listbox"], [role="tab"]';

/**
 * The action for one key. Ignored while typing in a field, except Esc and ⌘↵ (Ctrl+↵). With
 * single-key shortcuts off (WCAG 2.1.4) only those two and Enter on a row remain. Pure.
 */
export function resolveBenchKey(e: BenchKey, singleKeys = true): BenchAction | null {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Enter' && mod) return 'primary';
  if (e.key === 'Escape') return 'close';
  if (typing(e.target) || mod || e.altKey) return null;
  if (e.key === 'Enter') {
    const t = e.target as Element | null;
    return t?.closest?.(CONTROL) ? null : 'open';
  }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return singleKeys ? (SINGLE[key] ?? null) : null;
}

/**
 * Binds bench actions on the window. A key a control already took (`defaultPrevented`: the list's
 * arrows, the search's Esc) is left alone; a bound action prevents the browser's own.
 */
export function useBenchKeys(handlers: Partial<Record<BenchAction, () => void>>): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const action = resolveBenchKey(e, singleKeysOn());
      const run = action ? latest.current[action] : undefined;
      if (!run) return;
      e.preventDefault();
      run();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
}
