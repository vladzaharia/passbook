import { type TokenPurpose, tokenMac, unsealToken } from '../../platform/capability-token.ts';
import { macKeyVersion, macPreviousVersion } from '../../platform/crypto.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../settings/repo.ts';
import { remacTrusted } from './repo-pass-trusted.ts';
import { type MacRow, macRows } from './repo-token-remac.ts';

/** Rows read per kind and run; the D1 batches (rewrites) a run may make are capped by `WRITE_BUDGET`. */
const BATCH = 100;
export const WRITE_BUDGET = 30;
const ID_LOG_CAP = 20;
const CURSOR = 'tokens.remacCursor';
const DONE = 'tokens.remacDone';
const PROBE = 'tokens.macProbeAt';
const PROBE_EVERY_MS = 6 * 60 * 60_000;
const UNREADABLE = new Set(['TOKEN_SEAL_MISSING', 'TOKEN_SEAL_UNREADABLE', 'TOKEN_SEAL_MISMATCH']);
const PURPOSES = ['pass', 'apple-auth', 'bundle'] as const;

type After = Record<TokenPurpose, string | null>;
/** One sweep of one version pair: where it is, what it left, and what it could not read. */
interface Cursor {
  stamp: string;
  after: After;
  skipped: number;
  unreadable: number;
}
type Outcome = 'moved' | 'current' | 'skipped' | 'unreadable';

const fresh = (stamp: string): Cursor => ({
  stamp,
  after: { pass: null, 'apple-auth': null, bundle: null },
  skipped: 0,
  unreadable: 0,
});

/** A stored cursor of another version pair (or none) is no cursor: a swap starts the sweep over. */
function parseCursor(value: unknown, stamp: string): Cursor {
  const v = (value ?? {}) as Partial<Cursor> & { after?: Partial<After> };
  if (v.stamp !== stamp) return fresh(stamp);
  const id = (k: TokenPurpose) =>
    typeof v.after?.[k] === 'string' ? (v.after[k] as string) : null;
  return {
    stamp,
    after: { pass: id('pass'), 'apple-auth': id('apple-auth'), bundle: id('bundle') },
    skipped: typeof v.skipped === 'number' ? v.skipped : 0,
    unreadable: typeof v.unreadable === 'number' ? v.unreadable : 0,
  };
}

/**
 * Minute, while `MAC_KEY_VERSION_PREVIOUS` is set: rewrites the pass link, Apple web-service and bundle token
 * MACs from their sealed copies under the current MAC root, in id order, at most `WRITE_BUDGET` D1 batches a
 * run (the minute hooks share one invocation's subrequests). The cursor and the done marker belong to one
 * version pair (`previous>current`): swapping the pins mid-sweep, or pinning again after a finished sweep,
 * starts a new sweep. A row refused (pending transfer, forwarding reservation, changed since it was read)
 * makes the sweep run again; a row with no sealed copy (deleted pass, deleted org) or a copy that does not
 * match is counted and left on the previous root. When a sweep ends clean the pair is recorded and the
 * job stops; the owner then unsets MAC_KEY_VERSION_PREVIOUS (docs/operations.md, MAC key rotation).
 * With no previous root set, it only probes now and then that stored MACs still match the root.
 */
export async function remacCapabilityTokens(ctx: ServiceContext): Promise<void> {
  const previous = macPreviousVersion(ctx.env);
  if (previous === null) return probeMacRoot(ctx);
  const stamp = `${previous}>${macKeyVersion(ctx.env)}`;
  const db = ctx.env.DB;
  const done = await readSystemValue(db, DONE);
  if (done === stamp) return;
  const cursor = parseCursor(await readSystemValue(db, CURSOR), stamp);
  // A finished sweep of another pair no longer says anything about this one.
  if (done !== null) await writeSystemValue(db, DONE, null, ctx.clock.now());
  const lists = await Promise.all(PURPOSES.map((p) => macRows(db, p, cursor.after[p], BATCH)));
  if (lists.every((rows) => rows.length === 0)) {
    const again = cursor.skipped > 0;
    await writeSystemValue(db, CURSOR, fresh(stamp), ctx.clock.now());
    if (!again) await writeSystemValue(db, DONE, stamp, ctx.clock.now());
    ctx.log.info('tokens.remac', {
      code: again ? 'TOKEN_REMAC_RESWEEP' : 'TOKEN_REMAC_DONE',
      stamp,
      unreadable: cursor.unreadable,
      skipped: cursor.skipped,
    });
    return;
  }
  const counts: Record<Outcome, number> = { moved: 0, current: 0, skipped: 0, unreadable: 0 };
  const skippedIds: string[] = [];
  let writes = 0;
  const next = { ...cursor.after };
  for (const [i, purpose] of PURPOSES.entries()) {
    for (const row of lists[i] ?? []) {
      if (writes >= WRITE_BUDGET) break;
      const outcome = await remacOne(ctx, purpose, row);
      if (outcome === 'moved' || outcome === 'skipped') writes++;
      counts[outcome]++;
      if (outcome === 'skipped' && skippedIds.length < ID_LOG_CAP) skippedIds.push(row.id);
      next[purpose] = row.id;
    }
  }
  await writeSystemValue(
    db,
    CURSOR,
    {
      stamp,
      after: next,
      skipped: cursor.skipped + counts.skipped,
      unreadable: cursor.unreadable + counts.unreadable,
    },
    ctx.clock.now(),
  );
  ctx.log.info('tokens.remac', { code: 'TOKEN_REMAC_RUN', stamp, ...counts });
  if (skippedIds.length > 0)
    ctx.log.warn('tokens.remac_skipped', { code: 'TOKEN_REMAC_SKIPPED', stamp, ids: skippedIds });
}

/** One row on its own: a refused or failing row is counted and logged, and the sweep moves on. */
async function remacOne(ctx: ServiceContext, purpose: TokenPurpose, row: MacRow): Promise<Outcome> {
  try {
    const plain = await unsealToken(ctx.env, purpose, row.id, row.orgId, row.mac, row.seal);
    const to = await tokenMac(ctx.env, purpose, plain);
    if (to === row.mac) return 'current';
    return (await remacTrusted(ctx.env.DB, purpose, row.id, row.mac, to)) ? 'moved' : 'skipped';
  } catch (error) {
    // unsealToken logged a missing, unreadable or mismatching copy: it stays on the previous root.
    if (error instanceof AppError && UNREADABLE.has(error.code)) return 'unreadable';
    ctx.log.error('tokens.remac_failed', {
      code: 'TOKEN_REMAC_FAILED',
      purpose,
      id: row.id,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return 'skipped';
  }
}

/**
 * With no previous root, a stored MAC that matches the current root under no copy of its token means the
 * pin moved without `MAC_KEY_VERSION_PREVIOUS`: every such link and device call fails. Samples a few rows
 * every few hours and logs an error when any does not match.
 */
async function probeMacRoot(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  const last = await readSystemValue(db, PROBE);
  if (typeof last === 'number' && ctx.clock.now() - last < PROBE_EVERY_MS) return;
  await writeSystemValue(db, PROBE, ctx.clock.now(), ctx.clock.now());
  let mismatched = 0;
  let sampled = 0;
  for (const purpose of PURPOSES) {
    for (const row of await macRows(db, purpose, null, 3)) {
      if (!row.seal) continue;
      sampled++;
      try {
        await unsealToken(ctx.env, purpose, row.id, row.orgId, row.mac, row.seal);
      } catch (error) {
        if (error instanceof AppError && error.code === 'TOKEN_SEAL_MISMATCH') mismatched++;
      }
    }
  }
  if (mismatched > 0)
    ctx.log.error('tokens.mac_root_mismatch', {
      code: 'TOKEN_MAC_ROOT_MISMATCH',
      sampled,
      mismatched,
    });
}
