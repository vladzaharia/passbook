/** The Who's in list as a pure reducer: rows longest first, counts that never go back in time. */
import type { InsideList, InsidePlace, InsideRow } from './inside-types.ts';

export interface InsideState {
  /** The first page has not arrived yet. */
  loading: boolean;
  /** The last load failed; the list below it is the last good one. */
  error: boolean;
  q: string;
  /** A place key, or null for every place. */
  place: string | null;
  rows: InsideRow[];
  /** Rows that match the query, past the page. */
  total: number;
  next: string | null;
  places: InsidePlace[];
  asOf: number | null;
}

export type InsideAction =
  | { t: 'query'; q?: string; place?: string | null }
  | { t: 'loaded'; list: InsideList; append: boolean }
  | { t: 'failed' }
  | { t: 'removed'; passId: string }
  | { t: 'restored'; row: InsideRow }
  /** The server's count for a place after a mark-out. */
  | { t: 'count'; place: string; inNow: number };

export const initialInside = (): InsideState => ({
  loading: true,
  error: false,
  q: '',
  place: null,
  rows: [],
  total: 0,
  next: null,
  places: [],
  asOf: null,
});

/** Longest inside first; the pass id breaks a tie so the order never flickers. */
export const sortLongest = (rows: InsideRow[]): InsideRow[] =>
  [...rows].sort((a, b) => a.since - b.since || a.passId.localeCompare(b.passId));

/** A lower `rev` never replaces a higher one. */
export function mergePlaces(prev: InsidePlace[], next: InsidePlace[]): InsidePlace[] {
  const merged = next.map((n) => {
    const old = prev.find((p) => p.place === n.place);
    return old && old.rev > n.rev ? old : n;
  });
  return merged;
}

const nudge = (places: InsidePlace[], key: string, by: number): InsidePlace[] =>
  places.map((p) =>
    p.place === key ? { ...p, inNow: Math.max(0, p.inNow + by), rev: p.rev + 0.5 } : p,
  );

export function insideReducer(s: InsideState, a: InsideAction): InsideState {
  switch (a.t) {
    case 'query':
      return {
        ...s,
        ...(a.q !== undefined ? { q: a.q } : {}),
        ...(a.place !== undefined ? { place: a.place } : {}),
        error: false,
      };
    case 'loaded': {
      const rows = a.append
        ? sortLongest([
            ...s.rows,
            ...a.list.items.filter((i) => !s.rows.some((r) => r.passId === i.passId)),
          ])
        : sortLongest(a.list.items);
      return {
        ...s,
        loading: false,
        error: false,
        rows,
        total: a.list.total,
        next: a.list.nextCursor,
        places: mergePlaces(s.places, a.list.places),
        asOf: a.list.asOf,
      };
    }
    case 'failed':
      return { ...s, loading: false, error: true };
    case 'removed': {
      const row = s.rows.find((r) => r.passId === a.passId);
      if (!row) return s;
      return {
        ...s,
        rows: s.rows.filter((r) => r.passId !== a.passId),
        total: Math.max(0, s.total - 1),
        places: nudge(s.places, row.place, -1),
      };
    }
    case 'restored':
      if (s.rows.some((r) => r.passId === a.row.passId)) return s;
      return {
        ...s,
        rows: sortLongest([...s.rows, a.row]),
        total: s.total + 1,
        places: nudge(s.places, a.row.place, 1),
      };
    case 'count':
      return {
        ...s,
        places: s.places.map((p) => (p.place === a.place ? { ...p, inNow: a.inNow } : p)),
      };
  }
}

/** Long stay and Pass ended tint a row amber. */
export const flagged = (row: InsideRow): boolean => row.flags.length > 0;
