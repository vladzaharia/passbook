import { useEffect, useState } from 'react';
import { formatAgo, formatDateTime } from '../lib/format.ts';

/**
 * Re-renders every `ms` so relative times and countdowns stay true while a tab is open. While
 * `active` is false it stops ticking and keeps its last reading.
 */
export function useNow(ms = 30_000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return now;
}

/** "3 minutes ago", with the exact time on hover and in the markup. */
export function RelTime({ at, now }: { at: number; now: number }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={formatDateTime(at)}>
      {formatAgo(at, now)}
    </time>
  );
}
