// Who is inside a place now (SA §20.9 "Who's inside"): live in rows of this mode, oldest entry first.
// The route (WP-G) adds holder, photo and plan, and gates it on Desk actions.
import { insideReads, runReads } from './repo-reads.ts';

export interface InsideRow {
  passId: string;
  since: number;
  dueAt: number | null;
  /** The scanner of the last transition. */
  via: string | null;
}

export interface InsidePage {
  items: InsideRow[];
  total: number;
  nextCursor: string | null;
}

const MAX = 100;

const cursorOf = (row: InsideRow) => `${row.since}.${row.passId}`;

function parseCursor(cursor: string | null | undefined): { since: number; passId: string } | null {
  if (!cursor) return null;
  const dot = cursor.indexOf('.');
  const since = Number(cursor.slice(0, dot));
  const passId = cursor.slice(dot + 1);
  return dot > 0 && Number.isSafeInteger(since) && passId ? { since, passId } : null;
}

export async function insidePage(
  db: D1Database,
  q: {
    orgId: string;
    mode: string;
    place: string;
    now: number;
    cursor?: string | null;
    limit?: number;
  },
): Promise<InsidePage> {
  const limit = Math.min(Math.max(q.limit ?? MAX, 1), MAX);
  const [rows, counts] = await runReads(
    db,
    insideReads(q.orgId, q.mode, q.place, q.now, {
      after: parseCursor(q.cursor),
      limit: limit + 1,
    }),
  );
  const items = (rows?.results ?? []) as InsideRow[];
  const total = ((counts?.results ?? [])[0] as { n?: number } | undefined)?.n ?? 0;
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page, total, nextCursor: items.length > limit && last ? cursorOf(last) : null };
}
