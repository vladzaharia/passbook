/** Monthly usage periods and their local days, in an org's zone. Pure: no I/O. */

export interface Period {
  /** `YYYY-MM`, the local month the period is named for. */
  month: string;
  startMs: number;
  endMs: number;
}

export interface DayBounds {
  localDay: string;
  startMs: number;
  endMs: number;
}

const HOUR = 3_600_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** True when `zone` is a zone this runtime knows. */
export function validZone(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** Local year, month (1-12) and day of an instant. */
export function localDate(ms: number, zone: string): { y: number; m: number; d: number } {
  const v: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(ms)) v[p.type] = Number(p.value);
  return { y: v.year as number, m: v.month as number, d: v.day as number };
}

function offsetAt(ms: number, zone: string): number {
  const v: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(ms)) v[p.type] = Number(p.value);
  const asUtc = Date.UTC(
    v.year as number,
    (v.month as number) - 1,
    v.day as number,
    v.hour as number,
    v.minute as number,
    v.second as number,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant a local calendar day starts in `zone`. Month and day may overflow (month 13 is January). */
export function localMidnight(y: number, m: number, d: number, zone: string): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetAt(guess, zone);
  return guess - offsetAt(first, zone);
}

const pad = (n: number) => String(n).padStart(2, '0');

function norm(y: number, m: number): { y: number; m: number } {
  const i = y * 12 + (m - 1);
  return { y: Math.floor(i / 12), m: (i % 12) + 1 };
}

export const monthLabel = (y: number, m: number): string => {
  const n = norm(y, m);
  return `${n.y}-${pad(n.m)}`;
};

const parseMonth = (month: string) => ({
  y: Number(month.slice(0, 4)),
  m: Number(month.slice(5, 7)),
});

/** The month after `month`. */
export function nextMonth(month: string): string {
  const { y, m } = parseMonth(month);
  return monthLabel(y, m + 1);
}

/** The period named `month`, from local midnight of its first day to that of the next month's. */
export function periodOf(month: string, zone: string): Period {
  const { y, m } = parseMonth(month);
  return {
    month,
    startMs: localMidnight(y, m, 1, zone),
    endMs: localMidnight(y, m + 1, 1, zone),
  };
}

/** The period holding the instant, in `zone`. */
export function periodAt(ms: number, zone: string): Period {
  const { y, m } = localDate(ms, zone);
  return periodOf(monthLabel(y, m), zone);
}

/**
 * The period after `prev`. It starts where `prev` ended, so no instant is uncovered or counted twice. When the
 * zone changed, its first day runs from that instant to the next local midnight in the new zone.
 */
export function followingPeriod(prev: Period, zone: string): Period {
  const month = nextMonth(prev.month);
  return { month, startMs: prev.endMs, endMs: periodOf(nextMonth(month), zone).startMs };
}

/** Hours in a period (743 and 745 in the months a zone changes its clocks). */
export const periodHours = (p: Pick<Period, 'startMs' | 'endMs'>): number =>
  (p.endMs - p.startMs) / HOUR;

/** The local days of `period` that intersect [fromMs, toMs). */
export function daysBetween(
  period: Period,
  zone: string,
  fromMs: number,
  toMs: number,
): DayBounds[] {
  const { y, m } = parseMonth(period.month);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: DayBounds[] = [];
  for (let d = 1; d <= count; d++) {
    const startMs = d === 1 ? period.startMs : localMidnight(y, m, d, zone);
    const endMs = d === count ? period.endMs : localMidnight(y, m, d + 1, zone);
    if (endMs > fromMs && startMs < toMs) {
      out.push({ localDay: `${period.month}-${pad(d)}`, startMs, endMs });
    }
  }
  return out;
}
