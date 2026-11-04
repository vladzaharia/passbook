import { useEffect, useState } from 'react';
import { formatDateTime, formatRelative } from '../../../lib/format.ts';

/** Re-renders every `ms` so relative times stay true while a tab is open. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** "3 minutes ago", with the exact time on hover and in the markup. */
export function RelTime({ at, now }: { at: number; now: number }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={formatDateTime(at)}>
      {Math.abs(now - at) < 45_000 ? 'just now' : formatRelative(at, now)}
    </time>
  );
}
