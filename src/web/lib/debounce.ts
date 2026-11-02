import { useEffect, useRef, useState } from 'react';

/** The value after it stops changing for `ms`. */
export function useDebounced<T>(value: T, ms = 200): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * A text field that writes upstream once per pause, not per key. `value` is the committed text;
 * it overwrites the draft when it changes elsewhere (back button, clear).
 */
export function useDebouncedCommit(
  value: string,
  commit: (next: string) => void,
  ms = 250,
): readonly [string, (next: string) => void] {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  useEffect(() => {
    committed.current = value;
    setDraft(value);
  }, [value]);
  const settled = useDebounced(draft, ms);
  // Commit what the user typed once, not what an upstream change wrote back into the draft.
  useEffect(() => {
    if (settled !== draft || settled === committed.current) return;
    committed.current = settled;
    commit(settled);
  }, [settled, draft, commit]);
  return [draft, setDraft] as const;
}
