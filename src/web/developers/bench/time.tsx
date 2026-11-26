import {
  formatAgo,
  formatClockIn,
  formatFullIn,
  formatRelative,
  formatStampIn,
  todayKey,
} from '../../lib/format.ts';
import { useBenchZone } from './zone.ts';
import './kit.css';

/**
 * How a time reads: `auto` in lists (14:15:53 today, Nov 24, 14:15 on another day), `full` as an
 * inspector fact, `ago` for "last used", `until` for "expires in". Every mode is in the org's zone;
 * the tooltip is always the full moment, with the zone named.
 */
export type BenchTimeMode = 'auto' | 'full' | 'ago' | 'until';

/** The words for `at`; plain, for code that draws without React. */
export function benchTimeText(
  at: number,
  zone: string,
  mode: BenchTimeMode = 'auto',
  now: number = Date.now(),
): string {
  if (mode === 'full') return formatFullIn(at, zone);
  if (mode === 'ago') return formatAgo(at, now);
  if (mode === 'until') return formatRelative(at, now);
  return todayKey(zone, at) === todayKey(zone, now)
    ? formatClockIn(at, zone)
    : formatStampIn(at, zone);
}

/** One moment as `<time>`: machine-readable, in the org's zone, the full moment on hover. */
export function BenchTime({
  at,
  mode = 'auto',
  zone,
  now,
  className,
}: {
  at: number;
  mode?: BenchTimeMode;
  /** Tests and the home pass a zone; tools read the sandbox's. */
  zone?: string;
  now?: number;
  className?: string;
}) {
  const orgZone = useBenchZone();
  const tz = zone ?? orgZone;
  const full = formatFullIn(at, tz);
  return (
    <time
      className={className ? `bench-time ${className}` : 'bench-time'}
      dateTime={new Date(at).toISOString()}
      title={full}
    >
      {mode === 'full' ? full : benchTimeText(at, tz, mode, now)}
    </time>
  );
}
