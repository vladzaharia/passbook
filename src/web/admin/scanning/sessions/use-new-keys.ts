import { useRef } from 'react';

/**
 * The keys that appeared after the first load, so a row added by hand flashes and a load does not.
 * A key stays flagged: the animation plays once, when the row mounts.
 */
export function useNewKeys(keys: readonly string[], ready: boolean): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const flagged = useRef(new Set<string>());
  if (!ready) return flagged.current;
  if (seen.current === null) seen.current = new Set(keys);
  for (const k of keys)
    if (!seen.current.has(k)) {
      seen.current.add(k);
      flagged.current.add(k);
    }
  return flagged.current;
}
