import { loadKekRing } from '../../platform/crypto.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { recordKeyRing, recordMacRoots } from './mac-root-check.ts';
import { type Move, moveRows, selectEnvelopes } from './repo-rewrap.ts';
import { type CaptureMove, selectCaptures } from './repo-rewrap-captures.ts';
import { countOlderEnvelopes, hasOlderEnvelope } from './repo-rewrap-older.ts';
import { type Plan, planCaptures, planPlace } from './rewrap-plan.ts';
import { PLACES, stampOf } from './rewrap-tables.ts';

/** Per run: at most this many reads and write batches (the minute hooks share one invocation's queries). */
export const READ_BUDGET = 4;
export const WRITE_BUDGET = 4;
export const PAGE = 100;
export const WRITE_BATCH = 50;
const ID_LOG_CAP = 20;
/** A done pair is looked at again this often: for a row an old isolate wrote late, or one repaired by hand. */
export const RETRY_MS = 60 * 60_000;
export const CURSOR = 'keys.rewrapCursor';
export const DONE = 'keys.rewrapDone';

/** Tables the sweep visits: the registry, then the captured emails. */
const TABLES = [...PLACES.map((p) => p.table), 'captured_emails'] as const;

/** One sweep of one KEK pair (`stamp`): where it is, and what it has done and left. */
export interface Cursor {
  stamp: string;
  startedAt: number;
  sweep: number;
  /** Index into TABLES. */
  table: number;
  after: string | null;
  /** This sweep moved or lost a race: the next one must find nothing before the pair is done. */
  dirty: boolean;
  moved: number;
  raced: number;
  /** Unreadable rows seen in this sweep. */
  unreadable: number;
}

export interface Done {
  stamp: string;
  unreadable: number;
  at: number;
  startedAt: number;
  /** Rows still under each older KEK version (all places, captured emails by column) when the sweep ended. */
  remaining: Record<string, number>;
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' ? v : fallback);

/** A stored cursor of another pair (or none) is no cursor: a ring change starts the sweep over. */
export function parseCursor(value: unknown, stamp: string, now: number): Cursor {
  const v = (value ?? {}) as Partial<Cursor>;
  if (v.stamp !== stamp)
    return {
      stamp,
      startedAt: now,
      sweep: 1,
      table: 0,
      after: null,
      dirty: false,
      moved: 0,
      raced: 0,
      unreadable: 0,
    };
  return {
    stamp,
    startedAt: num(v.startedAt, now),
    sweep: num(v.sweep, 1),
    table: Math.min(num(v.table), TABLES.length),
    after: typeof v.after === 'string' ? v.after : null,
    dirty: v.dirty === true,
    moved: num(v.moved),
    raced: num(v.raced),
    unreadable: num(v.unreadable),
  };
}

/** The tables with a row under a KEK older than `current`. */
async function tablesWithOlder(db: D1Database, current: number): Promise<string[]> {
  const found: string[] = [];
  for (const table of TABLES) if (await hasOlderEnvelope(db, table, current)) found.push(table);
  return found;
}

/** Rows per older KEK version, summed over every place. */
async function remainingByVersion(
  db: D1Database,
  current: number,
): Promise<Record<string, number>> {
  const total: Record<string, number> = {};
  for (const table of TABLES)
    for (const { v, n } of await countOlderEnvelopes(db, table, current))
      total[String(v)] = (total[String(v)] ?? 0) + n;
  return total;
}

/**
 * Minute, while the KEK ring holds more than one version: moves every envelope to the newest KEK
 * (`rewrapSecret`: the DEK is kept, only `kek_version` and `wrapped_dek` change), table by table in key
 * order, at most `READ_BUDGET` reads and `WRITE_BUDGET` batches of `WRITE_BATCH` a run. Each write is a
 * compare-and-set on the envelope that was read, so a writer that replaced it wins. A sweep that moved or
 * lost anything is followed by another; the pair (`stamp`) is done after one clean sweep, which also
 * catches rows an old isolate wrote under the older KEK after the sweep passed. A row that does not open
 * is logged and left, and a done pair with such rows is swept again hourly. Once done, a run costs one
 * read. Afterwards the owner can retire the older KEK (docs/operations.md, KEK rotation).
 */
export async function rewrapEnvelopes(ctx: ServiceContext): Promise<void> {
  const ring = await loadKekRing(ctx.env);
  await recordKeyRing(ctx);
  await recordMacRoots(ctx);
  if (ring.keys.size < 2) return;
  const db = ctx.env.DB;
  const stamp = stampOf([...ring.keys.keys()]);
  const now = ctx.clock.now();
  const done = (await readSystemValue(db, DONE)) as Partial<Done> | null;
  if (done?.stamp === stamp) {
    if (now - num(done.at) < RETRY_MS) return;
    if (num(done.unreadable) === 0) {
      // An old isolate can write under the older KEK after the sweep passed: look at every place.
      const late = await tablesWithOlder(db, ring.current);
      if (late.length === 0) {
        await writeSystemValue(db, DONE, { ...done, at: now }, now);
        return;
      }
      ctx.log.warn('keys.rewrap', { code: 'KEK_REWRAP_LATE', stamp, tables: late });
    }
  }
  const cursor = parseCursor(await readSystemValue(db, CURSOR), stamp, now);
  if (done?.stamp === stamp) {
    // The retry of a done pair that left unreadable rows: a whole new sweep, with no done marker meanwhile.
    await writeSystemValue(db, DONE, null, now);
    cursor.startedAt = num(done.startedAt, cursor.startedAt);
    cursor.sweep++;
    Object.assign(cursor, { table: 0, after: null, dirty: false, unreadable: 0 });
  }
  const run = { moved: 0, raced: 0, unreadable: 0 };
  const bad: { table: string; ids: string[] }[] = [];
  let reads = 0;
  let writes = 0;
  try {
    while (reads < READ_BUDGET && writes < WRITE_BUDGET) {
      const name = TABLES[cursor.table];
      if (name === undefined) {
        if (cursor.dirty) {
          cursor.sweep++;
          Object.assign(cursor, { table: 0, after: null, dirty: false, unreadable: 0 });
          ctx.log.info('keys.rewrap', { code: 'KEK_REWRAP_RESWEEP', stamp, sweep: cursor.sweep });
          continue;
        }
        await writeSystemValue(
          db,
          DONE,
          {
            stamp,
            unreadable: cursor.unreadable,
            at: now,
            startedAt: cursor.startedAt,
            remaining: await remainingByVersion(db, ring.current),
          } satisfies Done,
          now,
        );
        ctx.log.info('keys.rewrap', {
          code: 'KEK_REWRAP_DONE',
          stamp,
          unreadable: cursor.unreadable,
        });
        break;
      }
      const limit = Math.min(PAGE, (WRITE_BUDGET - writes) * WRITE_BATCH);
      const place = PLACES[cursor.table];
      let read: number;
      let plan: Plan<Move | CaptureMove>;
      let write: (batch: (Move | CaptureMove)[]) => Promise<number>;
      if (place === undefined) {
        const rows = await selectCaptures(db, cursor.after, ring.current, limit);
        read = rows.length;
        plan = await planCaptures(ring, rows);
        write = (b) => moveRows(db, { table: 'captured_emails', moves: b as CaptureMove[] });
        cursor.after = rows.at(-1)?.pk ?? null;
      } else {
        const rows = await selectEnvelopes(db, place.table, cursor.after, ring.current, limit);
        read = rows.length;
        plan = await planPlace(ring, place.aad, rows);
        write = (b) => moveRows(db, { table: place.table, moves: b as Move[] });
        cursor.after = rows.at(-1)?.pk ?? null;
      }
      reads++;
      for (let i = 0; i < plan.moves.length; i += WRITE_BATCH) {
        const sent = plan.moves.slice(i, i + WRITE_BATCH);
        const moved = await write(sent);
        writes++;
        run.moved += moved;
        run.raced += sent.length - moved;
        cursor.moved += moved;
        cursor.raced += sent.length - moved;
        if (sent.length > 0) cursor.dirty = true;
      }
      if (plan.unreadable.length > 0) {
        run.unreadable += plan.unreadable.length;
        cursor.unreadable += plan.unreadable.length;
        bad.push({ table: name, ids: plan.unreadable.slice(0, ID_LOG_CAP) });
      }
      if (read < limit) Object.assign(cursor, { table: cursor.table + 1, after: null });
    }
  } catch (error) {
    ctx.log.error('keys.rewrap', {
      code: 'KEK_REWRAP_FAILED',
      stamp,
      table: TABLES[cursor.table] ?? null,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    // A batch may have been applied before the failure: the sweep must not be trusted as clean.
    cursor.dirty = true;
    try {
      await writeSystemValue(db, CURSOR, cursor, now);
    } catch (saved) {
      ctx.log.error('keys.rewrap', {
        code: 'KEK_REWRAP_STATE_LOST',
        stamp,
        errorName: saved instanceof Error ? saved.name : 'unknown',
      });
    }
    return;
  }
  await writeSystemValue(db, CURSOR, cursor, now);
  ctx.log.info('keys.rewrap', {
    code: 'KEK_REWRAP_RUN',
    stamp,
    sweep: cursor.sweep,
    table: TABLES[cursor.table] ?? null,
    ...run,
  });
  for (const b of bad)
    ctx.log.warn('keys.rewrap', {
      code: 'KEK_REWRAP_UNREADABLE',
      stamp,
      table: b.table,
      ids: b.ids,
    });
}
