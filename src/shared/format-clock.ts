// The developer Workbench's clock: a request, a delivery or a key's use at the second, in the org's
// zone (never UTC). web/lib/format.ts re-exports these, so the web formats through one module.
const LOCALE = 'en-US';
const cache = new Map<string, Intl.DateTimeFormat>();

const zoned = (name: string, timeZone: string, opts: Intl.DateTimeFormatOptions) => {
  const key = `${name}|${timeZone}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone });
    cache.set(key, formatter);
  }
  return formatter;
};

const H23 = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;

/** 14:15:53 on the clock of `timeZone`: a row's time when it is today there. */
export function formatClockIn(ms: number, timeZone: string): string {
  return zoned('clock', timeZone, { ...H23, second: '2-digit' }).format(ms);
}

/** Nov 24, 14:15 in `timeZone`: a row's time on another day. */
export function formatStampIn(ms: number, timeZone: string): string {
  const day = zoned('md', timeZone, { month: 'short', day: 'numeric' });
  return `${day.format(ms)}, ${zoned('hm', timeZone, H23).format(ms)}`;
}

/** Nov 25, 2026, 2:15:53 PM PST: one moment in full with its zone named (a tooltip, an inspector fact). */
export function formatFullIn(ms: number, timeZone: string): string {
  const day = zoned('day', timeZone, { month: 'short', day: 'numeric', year: 'numeric' });
  const time = zoned('time', timeZone, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
  return `${day.format(ms)}, ${time.format(ms)}`;
}
