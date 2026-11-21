import type { SetupHours } from './contracts/scan-setup-intent.ts';
import type { SessionHours } from './contracts/scanning-sessions.ts';
import type { ScanSetupIssueCode } from './copy/scan-setup.ts';

export interface SetupIssue {
  code: ScanSetupIssueCode;
  path: (string | number)[];
  params?: Record<string, string>;
}

/** A new place tracks who is inside when it has a max, a count, a max stay or a clear-at. */
export const isTracked = (p: {
  max?: number;
  count?: boolean;
  maxStayMinutes?: number;
  clearAt?: string;
}): boolean =>
  p.max !== undefined ||
  p.count === true ||
  p.maxStayMinutes !== undefined ||
  p.clearAt !== undefined;

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** The session's weekly hours and closed dates; null is always open; 'empty' has no weekly span. */
export function sessionHoursOf(hours: SetupHours | undefined): SessionHours | null | 'empty' {
  if (hours === undefined || hours === 'always') return null;
  const out: SessionHours = {};
  for (const day of DAYS) {
    const spans = hours[day] ?? hours.every;
    if (spans) out[day] = spans;
  }
  if (DAYS.every((d) => out[d] === undefined)) return 'empty';
  if (hours.closed?.length) out.dates = Object.fromEntries(hours.closed.map((d) => [d, []]));
  return out;
}

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const pad = (n: number) => String(n).padStart(2, '0');

/** The latest weekly closing time, as HH:MM (a span past midnight closes the next morning). */
export function lastClose(hours: readonly (SessionHours | null)[]): string | null {
  let latest = -1;
  for (const h of hours)
    for (const day of DAYS)
      for (const span of h?.[day] ?? []) {
        const start = minutes(span);
        const end = minutes(span.slice(6));
        latest = Math.max(latest, end > start ? end : end + 1440);
      }
  if (latest < 0) return null;
  const at = latest % 1440;
  return `${pad(Math.floor(at / 60))}:${pad(at % 60)}`;
}

/** A zone key from a name, unique among `taken` (`pool`, `pool-2`). */
export function zoneKeyFor(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34)
      .replace(/-+$/, '') || 'zone';
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

/** "<door> <n>", cut so it fits a device name (40). */
export function deviceName(door: string, n: number): string {
  const suffix = ` ${n}`;
  return `${Array.from(door)
    .slice(0, 40 - suffix.length)
    .join('')
    .trimEnd()}${suffix}`;
}

/**
 * Parents first. Each place names its parent by ref; a ref chain that loops is a cycle, and a chain
 * longer than the depth limit (counting the existing ancestors of an id parent) is too deep.
 */
export function placeDepths(
  places: { ref: string; parentRef: string | null; parentDepth: number }[],
  maxDepth: number,
): { order: string[]; issues: { ref: string; code: 'ZONE_CYCLE' | 'ZONE_DEPTH' }[] } {
  const byRef = new Map(places.map((p) => [p.ref, p]));
  const depth = new Map<string, number>();
  const issues: { ref: string; code: 'ZONE_CYCLE' | 'ZONE_DEPTH' }[] = [];
  const order: string[] = [];
  const visit = (ref: string, path: Set<string>): number => {
    const known = depth.get(ref);
    if (known !== undefined) return known;
    const p = byRef.get(ref);
    if (!p) return 0;
    if (path.has(ref)) return Number.POSITIVE_INFINITY;
    path.add(ref);
    const d = p.parentRef === null ? p.parentDepth : visit(p.parentRef, path) + 1;
    depth.set(ref, d);
    if (Number.isFinite(d)) order.push(ref);
    return d;
  };
  for (const p of places) {
    const d = visit(p.ref, new Set());
    if (!Number.isFinite(d)) issues.push({ ref: p.ref, code: 'ZONE_CYCLE' });
    else if (d > maxDepth) issues.push({ ref: p.ref, code: 'ZONE_DEPTH' });
  }
  return { order, issues };
}
