import { useSyncExternalStore } from 'react';
import { MODE_HEADER, type Mode } from '@/shared/contracts/common.ts';

/** Per browser: Test mode stays on across reloads and tabs until it is turned off. */
export const MODE_KEY = 'passbook-mode';

function stored(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'test' ? 'test' : 'live';
  } catch {
    // Storage can be blocked (private mode); the tab starts live.
    return 'live';
  }
}

let current: Mode = stored();
const listeners = new Set<(mode: Mode) => void>();

export const getMode = (): Mode => current;

function apply(next: Mode): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener(next);
}

export function setMode(next: Mode): void {
  if (next === current) return;
  try {
    if (next === 'test') localStorage.setItem(MODE_KEY, 'test');
    else localStorage.removeItem(MODE_KEY);
  } catch {
    // Not saved; the choice still holds for this tab.
  }
  apply(next);
}

/** Runs after every change, including one made in another tab. Returns the unsubscribe. */
export function onModeChange(listener: (mode: Mode) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === MODE_KEY || event.key === null) apply(stored());
  });
}

export function useMode(): Mode {
  return useSyncExternalStore(onModeChange, getMode, () => 'live');
}

/** The header every admin API request carries while Test mode is on. */
export function modeHeaders(): Record<string, string> {
  return current === 'test' ? { [MODE_HEADER]: 'test' } : {};
}

/** Test seam: back to live without touching storage listeners. */
export function resetModeForTests(): void {
  try {
    localStorage.removeItem(MODE_KEY);
  } catch {
    // Nothing stored.
  }
  apply('live');
}
