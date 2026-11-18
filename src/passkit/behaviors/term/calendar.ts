interface Local {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function localOf(ms: number, tz: string): Local {
  const l: Local = { y: 0, mo: 1, d: 1, h: 0, mi: 0, s: 0 };
  const keys: Record<string, keyof Local> = {
    year: 'y',
    month: 'mo',
    day: 'd',
    hour: 'h',
    minute: 'mi',
    second: 's',
  };
  for (const part of formatter(tz).formatToParts(new Date(ms))) {
    const key = keys[part.type];
    if (key) l[key] = Number(part.value);
  }
  return l;
}

const offsetAt = (ms: number, tz: string): number => {
  const l = localOf(ms, tz);
  return Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s) - Math.floor(ms / 1000) * 1000;
};

/** Wall time to an instant. A time skipped by a DST jump lands after the jump; a repeated one takes the first. */
export function instantOf(l: Local, tz: string): number {
  const wall = Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s);
  const first = wall - offsetAt(wall, tz);
  const second = wall - offsetAt(first, tz);
  return second === first ? first : wall - offsetAt(second, tz) === second ? second : first;
}

export function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Adds calendar months anchored on `l`; a day past the end of the target month clamps to its last day. */
export function addMonths(l: Local, months: number): Local {
  const index = l.y * 12 + (l.mo - 1) + months;
  const y = Math.floor(index / 12);
  const mo = (index % 12) + 1;
  return { ...l, y, mo, d: Math.min(l.d, daysInMonth(y, mo)) };
}

export function addDays(l: Local, days: number): Local {
  const t = new Date(Date.UTC(l.y, l.mo - 1, l.d + days));
  return { ...l, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export type { Local };
