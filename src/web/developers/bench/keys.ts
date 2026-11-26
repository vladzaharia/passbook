import { useEffect, useRef } from 'react';
import type { BenchTool } from './switcher.tsx';
import { typing } from './toolbar.tsx';

/** What a key does on the bench (design §3.7). Tools bind the ones they have. */
export type BenchAction =
  | 'next'
  | 'prev'
  | 'open'
  | 'close'
  | 'primary'
  | 'copyId'
  | 'copyCurl'
  | 'help'
  | `tool:${BenchTool}`;

export interface BenchKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

const TOOL_KEYS: Record<string, BenchTool> = { c: 'console', w: 'webhooks', l: 'logs', k: 'keys' };
const SINGLE: Record<string, BenchAction> = {
  j: 'next',
  k: 'prev',
  y: 'copyId',
  c: 'copyCurl',
  '?': 'help',
};
/** A focused control keeps Enter: it is a key for it, not the bench. */
const CONTROL = 'a[href], button, input, select, textarea, summary, [role="listbox"], [role="tab"]';

/**
 * The action for one key, given whether a `g` came just before it. Ignored while typing in a field,
 * except Esc and ⌘↵ (Ctrl+↵). `g` then c / w / l / k switches tools. Pure: the hook keeps the chord.
 */
export function resolveBenchKey(
  e: BenchKey,
  chord: boolean,
): { action: BenchAction | null; chord: boolean } {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Enter' && mod) return { action: 'primary', chord: false };
  if (e.key === 'Escape') return { action: 'close', chord: false };
  if (typing(e.target) || mod || e.altKey) return { action: null, chord: false };
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (chord) {
    const tool = TOOL_KEYS[key];
    return { action: tool ? `tool:${tool}` : null, chord: false };
  }
  if (key === 'g') return { action: null, chord: true };
  if (e.key === 'Enter') {
    const t = e.target as Element | null;
    return { action: t?.closest?.(CONTROL) ? null : 'open', chord: false };
  }
  return { action: SINGLE[e.key] ?? null, chord: false };
}

/** A `g` waits this long for its second key. */
const CHORD_MS = 1200;

/**
 * Binds bench actions on the window. A key a control already took (`defaultPrevented`: the list's
 * arrows, the search's Esc) is left alone; a bound action prevents the browser's own.
 */
export function useBenchKeys(handlers: Partial<Record<BenchAction, () => void>>): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    let chord = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const next = resolveBenchKey(e, chord);
      chord = next.chord;
      clearTimeout(timer);
      if (chord)
        timer = setTimeout(() => {
          chord = false;
        }, CHORD_MS);
      const run = next.action ? latest.current[next.action] : undefined;
      if (!run) return;
      e.preventDefault();
      run();
    };
    addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      removeEventListener('keydown', onKey);
    };
  }, []);
}
