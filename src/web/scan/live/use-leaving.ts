import { useEffect, useState } from 'react';

/** How long the amount fades out when a draft is cancelled. */
export const LEAVE_MS = 150;

/**
 * The last defined value, kept for `LEAVE_MS` after it goes away so a fade can play. With reduced
 * motion the value goes at once.
 */
export function useLeaving<T>(value: T | undefined): { value: T | undefined; leaving: boolean } {
  const [last, setLast] = useState<T | undefined>(value);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (value !== undefined) {
      setLast(value);
      setLeaving(false);
      return;
    }
    if (last === undefined) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setLast(undefined);
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setLast(undefined);
      setLeaving(false);
    }, LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [value, last]);
  return value !== undefined
    ? { value, leaving: false }
    : { value: leaving ? last : undefined, leaving };
}
