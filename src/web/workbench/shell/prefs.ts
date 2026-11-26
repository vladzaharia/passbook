import { useSyncExternalStore } from 'react';
import { personKey } from './person.ts';

/**
 * Single-key shortcuts (WCAG 2.1.4): on by default, saved per person in this browser. Off, every
 * printable single key stops (letters, `g` chords, `?`); ⌘K, ⌘↵, ⌘S, ⌘/ and Esc remain.
 */
const key = () => personKey('wb-single-keys');
const subs = new Set<() => void>();
/** The choice when storage is blocked: it holds for this page only. */
let fallback: boolean | undefined;

export function singleKeysOn(): boolean {
  try {
    return localStorage.getItem(key()) !== 'off';
  } catch {
    return true;
  }
}

export function setSingleKeys(on: boolean): void {
  try {
    if (on) localStorage.removeItem(key());
    else localStorage.setItem(key(), 'off');
  } catch {
    fallback = on;
  }
  for (const sub of subs) sub();
}

function subscribe(sub: () => void): () => void {
  subs.add(sub);
  const onStorage = (e: StorageEvent) => {
    if (e.key === key() || e.key === null) sub();
  };
  addEventListener('storage', onStorage);
  return () => {
    subs.delete(sub);
    removeEventListener('storage', onStorage);
  };
}

export function useSingleKeys(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => fallback ?? singleKeysOn(),
    () => true,
  );
}
