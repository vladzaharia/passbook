import { useEffect, useState } from 'react';
import type { AssignError } from '../machine/assign-state.ts';

/** Seconds left on a "too many tries" wait, ticking down to 0; null for any other error. */
export function useRetryWait(e: AssignError | null | undefined): number | null {
  const total = e?.kind === 'too_many' ? (e.seconds ?? 10) : null;
  const [left, setLeft] = useState(total);
  useEffect(() => {
    setLeft(total);
    if (total === null) return;
    const end = Date.now() + total * 1000;
    const t = setInterval(() => {
      const next = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(next);
      if (next === 0) clearInterval(t);
    }, 250);
    return () => clearInterval(t);
  }, [total]);
  return left;
}
