// Who's in (SA §20.9): the page logic. Identity is injected: a scan role sees what its template shows, the console the title.
import type { ScanWhosInList, ScanWhosInRow } from '../../../../shared/contracts/scan-whos-in.ts';
import type { InsideScope } from './inside-scope.ts';
import { type InsideCursor, insideDistinctRead, insideRowsRead } from './repo-inside.ts';
import { countsRead, revsRead, runReads } from './repo-reads.ts';

export interface WhoIdentity {
  holder: string | null;
  photoUrl: string | null;
  plan: string | null;
  /** The plan label, else the template name. */
  type: string | null;
  host: string | null;
  /** The pass can no longer be used. */
  ended: boolean;
}
export type Identify = (passIds: readonly string[]) => Promise<Map<string, WhoIdentity>>;

interface Row {
  passId: string;
  place: string;
  since: number;
  dueAt: number | null;
  via: string | null;
}

/** Rows examined for one filtered page before it answers with a cursor instead of reading on. */
const EXAMINE_MAX = 500;
const LONG_STAY = 0.75;

const cursorOf = (r: Row) => `${r.since}.${r.passId}.${r.place}`;

function parseCursor(raw: string | undefined): InsideCursor | null {
  if (!raw) return null;
  const a = raw.indexOf('.');
  const b = raw.indexOf('.', a + 1);
  const since = Number(raw.slice(0, a));
  const passId = raw.slice(a + 1, b);
  const place = raw.slice(b + 1);
  return a > 0 && b > a && Number.isSafeInteger(since) && passId && place
    ? { since, passId, place }
    : null;
}

export interface WhosInQuery {
  db: D1Database;
  orgId: string;
  mode: string;
  scope: InsideScope;
  place?: string | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  limit: number;
  now: number;
  identify: Identify;
}

const EMPTY: ScanWhosInList = { items: [], count: 0, rev: 0, places: [], nextCursor: null };

export async function whosInList(i: WhosInQuery): Promise<ScanWhosInList> {
  const { scope, now } = i;
  const byPlace = new Map(scope.places.map((p) => [p.place, p]));
  if (i.place && !byPlace.has(i.place)) return EMPTY;
  const places = i.place ? [i.place] : scope.places.map((p) => p.place);
  if (places.length === 0) return EMPTY;
  const read = {
    orgId: i.orgId,
    mode: i.mode,
    places,
    // One place asked for: everyone in it is listed, even those who are deeper.
    nested: i.place ? {} : scope.nested,
    now,
  };
  const all = scope.places.map((p) => p.place);
  const [counts, revs, distinct] = await runReads(i.db, [
    countsRead(i.orgId, i.mode, all, now),
    revsRead(i.orgId, i.mode, all),
    insideDistinctRead(read),
  ]);
  const n = new Map(
    ((counts?.results ?? []) as { place: string; n: number }[]).map((r) => [r.place, r.n]),
  );
  const rev = new Map(
    ((revs?.results ?? []) as { place: string; rev: number }[]).map((r) => [r.place, r.rev]),
  );
  const q = i.q?.toLowerCase() ?? '';
  const size = q ? 100 : i.limit + 1;
  const items: ScanWhosInRow[] = [];
  let after = parseCursor(i.cursor);
  let last: Row | null = null;
  let more = false;
  let examined = 0;
  for (;;) {
    const page = (await runReads(i.db, [insideRowsRead(read, after, size)]))[0];
    const rows = (page?.results ?? []) as unknown as Row[];
    const who = await i.identify([...new Set(rows.map((r) => r.passId))]);
    for (const r of rows) {
      const id = who.get(r.passId);
      if (!id) {
        // A pass this reader may not see is skipped, never named.
        last = r;
        examined += 1;
        continue;
      }
      if (q && !(id.holder ?? '').toLowerCase().includes(q)) {
        last = r;
        examined += 1;
        continue;
      }
      if (items.length === i.limit) {
        more = true;
        break;
      }
      const p = byPlace.get(r.place);
      const flags: ScanWhosInRow['flags'] = [];
      if (p?.maxStayMs && now - r.since >= p.maxStayMs * LONG_STAY) flags.push('long_stay');
      if (id.ended) flags.push('pass_ended');
      items.push({
        passId: r.passId,
        holder: id.holder,
        photoUrl: id.photoUrl,
        plan: id.plan,
        type: id.type,
        host: id.host,
        place: r.place,
        placeName: p?.name ?? '',
        parentName: p?.parentName ?? null,
        since: r.since,
        dueAt: r.dueAt,
        via: r.via,
        flags,
      });
      last = r;
      examined += 1;
    }
    if (more || rows.length < size) break;
    if (examined >= EXAMINE_MAX) {
      more = true;
      break;
    }
    const tail = rows[rows.length - 1];
    after = tail ? { since: tail.since, passId: tail.passId, place: tail.place } : null;
  }
  return {
    items,
    count: ((distinct?.results ?? [])[0] as { n?: number } | undefined)?.n ?? 0,
    rev: Math.max(0, ...places.map((p) => rev.get(p) ?? 0)),
    places: scope.places.map((p) => ({
      place: p.place,
      name: p.name,
      inNow: n.get(p.place) ?? 0,
      capacity: p.capacity,
      rev: rev.get(p.place) ?? 0,
    })),
    nextCursor: more && last ? cursorOf(last) : null,
  };
}
