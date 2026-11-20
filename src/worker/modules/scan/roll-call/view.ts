// The roll call as a device reads it: the frozen list, each person's mark and where they stand now.
import type { RollCall, RollCallPerson } from '../../../../shared/contracts/scan-roll-call.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import type { WhoIdentity } from '../occupancy/inside-list.ts';
import type { Caller } from './caller.ts';
import {
  type CallRow,
  type MarkRow,
  marksOf,
  type PlaceInfo,
  type PresenceNow,
  presenceNow,
  type SnapshotPerson,
} from './repo.ts';

/** Pages of Who's in read to find people who tapped in after the start (100 a page). */
const LATE_PAGES = 20;
/** As many passes as one page of Who's in names. */
const IDENTIFY_CHUNK = 100;
const SYSTEM_EXIT = new Set(['stay', 'clear', 'zone']);

/** The people inside now who are not in the snapshot. */
async function arrivals(caller: Caller, known: ReadonlySet<string>): Promise<SnapshotPerson[]> {
  const found: SnapshotPerson[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LATE_PAGES; page++) {
    const list = await caller.list({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const r of list.items)
      if (!known.has(r.passId)) found.push({ passId: r.passId, place: r.place, since: r.since });
    if (!list.nextCursor) break;
    cursor = list.nextCursor;
  }
  return found;
}

function presenceOf(row: PresenceNow | undefined, now: number): RollCallPerson['presence'] {
  if (!row) return 'left';
  if (row.state === 'in') return row.dueAt !== null && row.dueAt <= now ? 'lapsed' : 'in';
  return row.outCause && SYSTEM_EXIT.has(row.outCause) ? 'lapsed' : 'left';
}

export function person(
  p: SnapshotPerson,
  who: WhoIdentity | undefined,
  places: ReadonlyMap<string, PlaceInfo>,
  mark: MarkRow | undefined,
  at: PresenceNow | undefined,
  now: number,
  late: boolean,
): RollCallPerson {
  const m = mark && mark.status !== 'none' ? mark : null;
  const presence = presenceOf(at, now);
  return {
    passId: p.passId,
    holder: who?.holder ?? null,
    plan: who?.plan ?? null,
    host: who?.host ?? null,
    place: p.place,
    placeName: places.get(p.place)?.name ?? '',
    since: p.since,
    basis: places.get(p.place)?.basis ?? 'tapped_in',
    presence,
    late,
    mark: m ? { status: m.status, by: m.by, at: m.at } : null,
    notConfirmedOut: presence === 'lapsed' && !m,
  };
}

/** Not confirmed out and not safe first, then longest inside. */
const order = (a: RollCallPerson, b: RollCallPerson) =>
  Number(Boolean(a.mark)) - Number(Boolean(b.mark)) ||
  Number(b.notConfirmedOut) - Number(a.notConfirmedOut) ||
  a.since - b.since ||
  a.passId.localeCompare(b.passId);

export async function rollCallView(
  ctx: ServiceContext,
  caller: Caller,
  call: CallRow,
): Promise<RollCall> {
  const now = ctx.clock.now();
  const db = ctx.env.DB;
  const marks = await marksOf(db, caller.orgId, caller.mode, call.id);
  const byPass = new Map(marks.map((m) => [m.passId, m]));
  const places = new Map(call.places.map((p) => [p.place, p]));
  const member = new Set(call.snapshot.map((p) => p.passId));
  const lateRows = new Map<string, SnapshotPerson>();
  for (const m of marks) if (m.late) lateRows.set(m.passId, m.late);
  // A call that has ended is a record: nobody new joins it.
  if (call.endedAt === null)
    for (const p of await arrivals(caller, member)) lateRows.set(p.passId, p);
  const lateList = [...lateRows.values()].filter((p) => !member.has(p.passId));
  const everyone = [...call.snapshot, ...lateList];
  const presence = new Map<string, PresenceNow>();
  const rows = await presenceNow(
    db,
    caller.orgId,
    caller.mode,
    everyone.map((p) => p.passId),
    call.places.map((p) => p.place),
  );
  for (const r of rows) presence.set(`${r.passId}|${r.place}`, r);
  const lateIds = new Set(lateList.map((p) => p.passId));
  const who = new Map<string, WhoIdentity>();
  const ids = everyone.map((p) => p.passId);
  for (let i = 0; i < ids.length; i += IDENTIFY_CHUNK)
    for (const [k, v] of await caller.identify(ids.slice(i, i + IDENTIFY_CHUNK))) who.set(k, v);
  const people = everyone
    .map((p) =>
      person(
        p,
        who.get(p.passId),
        places,
        byPass.get(p.passId),
        presence.get(`${p.passId}|${p.place}`),
        now,
        lateIds.has(p.passId),
      ),
    )
    .sort(order);
  const count = (f: (p: RollCallPerson) => boolean) => people.filter(f).length;
  return {
    id: call.id,
    placeNames: call.places.map((p) => p.name),
    startedAt: call.startedAt,
    startedBy: call.startedBy,
    endedAt: call.endedAt,
    endedBy: call.endedBy,
    rev: call.rev,
    serverNow: now,
    counts: {
      total: people.length,
      present: count((p) => p.mark?.status === 'present'),
      out: count((p) => p.mark?.status === 'out'),
      unconfirmed: count((p) => !p.mark),
      notConfirmedOut: count((p) => p.notConfirmedOut),
      late: lateIds.size,
      inNow: count((p) => p.basis === 'in_now'),
      tappedIn: count((p) => p.basis === 'tapped_in'),
    },
    people,
  };
}
