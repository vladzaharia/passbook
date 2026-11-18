import { type KekRing, loadKekRing, rewrapSecret } from '../../platform/crypto.ts';
import { fromBase64, toBase64 } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { recordMacRoots } from './mac-root-check.ts';
import {
  type CaptureMove,
  type Move,
  moveCaptures,
  moveEnvelopes,
  type RawCapture,
  selectCaptures,
  selectEnvelopes,
} from './repo-rewrap.ts';
import { captureAad, PLACES, type Raw, stampOf } from './rewrap-tables.ts';

/** Per run: at most this many reads and write batches (the minute hooks share one invocation's queries). */
export const READ_BUDGET = 4;
export const WRITE_BUDGET = 4;
export const PAGE = 100;
export const WRITE_BATCH = 50;
const ID_LOG_CAP = 20;
/** A sweep that left rows unreadable is tried again this often, so a row repaired by hand is picked up. */
export const UNREADABLE_RETRY_MS = 60 * 60_000;
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
}

const EMPTY = new Uint8Array(0);

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

const bytes = (value: ArrayBuffer | number[]): Uint8Array =>
  value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value);

interface Plan<M> {
  moves: M[];
  unreadable: string[];
}

/** Rewraps the DEK of each row; a row whose AAD does not open (wrong org, damaged) is left and counted. */
async function planPlace(
  ring: KekRing,
  aad: (row: Raw) => string,
  rows: Raw[],
): Promise<Plan<Move>> {
  const plan: Plan<Move> = { moves: [], unreadable: [] };
  for (const row of rows) {
    const wrapped = bytes(row.wrapped_dek);
    try {
      const next = await rewrapSecret(
        ring,
        { kekVersion: row.kek_version, iv: EMPTY, wrappedDek: wrapped, ciphertext: EMPTY },
        aad(row),
      );
      plan.moves.push({
        pk: row.pk,
        kek: row.kek_version,
        wrapped,
        nextKek: next.kekVersion,
        nextWrapped: next.wrappedDek,
      });
    } catch {
      plan.unreadable.push(row.pk);
    }
  }
  return plan;
}

/** `enc1:<kek>.<iv>.<wrapped DEK>.` of a sealed body, and the same under the current KEK. */
async function captureHead(
  ring: KekRing,
  head: string | null,
  aad: string,
): Promise<{ from: string; to: string }> {
  const none = { from: '', to: '' };
  if (head === null) return none;
  const m = /^enc1:(\d+)\.([^.]+)\.([^.]+)\./.exec(head);
  if (!m) throw new Error('capture header');
  const kek = Number(m[1]);
  if (kek >= ring.current) return none;
  const next = await rewrapSecret(
    ring,
    { kekVersion: kek, iv: EMPTY, wrappedDek: fromBase64(m[3] ?? ''), ciphertext: EMPTY },
    aad,
  );
  return { from: m[0], to: `enc1:${ring.current}.${m[2]}.${toBase64(next.wrappedDek)}.` };
}

async function planCaptures(ring: KekRing, rows: RawCapture[]): Promise<Plan<CaptureMove>> {
  const plan: Plan<CaptureMove> = { moves: [], unreadable: [] };
  for (const row of rows) {
    try {
      const aad = captureAad(row.pk, row.org_id);
      const html = await captureHead(ring, row.html, aad);
      const text = await captureHead(ring, row.text, aad);
      if (html.from === '' && text.from === '') throw new Error('nothing to move');
      plan.moves.push({ pk: row.pk, html, text });
    } catch {
      plan.unreadable.push(row.pk);
    }
  }
  return plan;
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
  await recordMacRoots(ctx);
  if (ring.keys.size < 2) return;
  const db = ctx.env.DB;
  const stamp = stampOf([...ring.keys.keys()]);
  const now = ctx.clock.now();
  const done = (await readSystemValue(db, DONE)) as Partial<Done> | null;
  if (done?.stamp === stamp) {
    if (num(done.unreadable) === 0 || now - num(done.at) < UNREADABLE_RETRY_MS) return;
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
        write = (b) => moveCaptures(db, b as CaptureMove[]);
        cursor.after = rows.at(-1)?.pk ?? null;
      } else {
        const rows = await selectEnvelopes(db, place.table, cursor.after, ring.current, limit);
        read = rows.length;
        plan = await planPlace(ring, place.aad, rows);
        write = (b) => moveEnvelopes(db, place.table, b as Move[]);
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
