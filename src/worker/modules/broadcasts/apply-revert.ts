import type { Json } from '../../../shared/contracts/common.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dispatchSafely } from '../delivery/issuance-intent.ts';
import { recordPassEvent } from '../events/record.ts';
import { publishPass } from '../passes/publish.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { actorOf } from './actor.ts';
import { type BroadcastRow, casState, handledPassIds, type ItemRow, insertItems } from './repo.ts';
import { creatorIsActive, creatorLive } from './repo-creator.ts';
import { hasVersionFrom, revertItems } from './repo-items.ts';

/** Passes per undo step: each is a read and a publish. */
const REVERT_CHUNK = 10;

interface Touched {
  from: Record<string, Json>;
  to: Record<string, Json>;
}

function touchedOf(json: string | null): Touched | null {
  try {
    const v = json === null ? null : (JSON.parse(json) as Touched);
    return v && typeof v.from === 'object' && typeof v.to === 'object' ? v : null;
  } catch {
    return null;
  }
}

const same = (a: Json | undefined, b: Json | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const atValues = (have: Record<string, Json | undefined>, want: Record<string, Json>) =>
  Object.entries(want).every(([k, v]) => same(have[k], v));

const changed = () =>
  new ConflictError('The pass changed since the run.', 'BROADCAST_PASS_CHANGED');

/**
 * Puts one pass's touched inputs back, only while each still holds the value the run wrote: a later
 * edit keeps the pass (and a pass edited elsewhere keeps its other inputs). Silent: no change message
 * fires. The write re-proves the undo's asker and fences on the pass itself.
 */
async function revertOne(
  ctx: ServiceContext,
  undo: BroadcastRow,
  passId: string,
  before: string | null,
): Promise<ItemRow> {
  const base = { passId, silent: false };
  const touched = touchedOf(before);
  const pass = await getPass(ctx.env.DB, passId, undo.org_id);
  if (
    !touched ||
    !pass ||
    pass.mode !== undo.mode ||
    pass.status !== 'active' ||
    pass.removedAt !== null
  ) {
    // No earlier values (the run died after its write), or the pass is gone or no longer active.
    if (!touched)
      ctx.log.warn('broadcast.undo_kept', { broadcastId: undo.id, code: 'UNDO_NO_BEFORE' });
    return { ...base, outcome: 'unchanged' };
  }
  if (atValues(pass.personalization, touched.from)) {
    // An earlier try of this restore published and died before its item: count it once.
    const done = await hasVersionFrom(ctx.env.DB, passId, 'schedule', undo.started_at ?? 0);
    return { ...base, outcome: done ? 'updated' : 'unchanged' };
  }
  if (!atValues(pass.personalization, touched.to)) return { ...base, outcome: 'unchanged' };
  try {
    await publishPass(ctx, {
      passId,
      orgScope: undo.org_id,
      cause: undo.created_by_type === 'api_key' ? 'api' : 'admin',
      source: 'schedule',
      actor: actorOf(undo),
      dispatch: false,
      notify: false,
      extraChecks: [creatorLive(undo, ctx.clock.now())],
      mutate: (current) => {
        if (
          current.orgId !== undo.org_id ||
          current.mode !== undo.mode ||
          current.status !== 'active' ||
          current.removedAt !== null ||
          !atValues(current.personalization, touched.to)
        )
          throw changed();
        const next = { ...current.personalization };
        for (const [k, v] of Object.entries(touched.from)) {
          if (v === null) delete next[k];
          else next[k] = v;
        }
        return { personalization: next };
      },
    });
    await recordPassEvent(ctx, {
      orgId: undo.org_id,
      passId,
      mode: undo.mode,
      kind: 'schedule.applied',
      actor: actorOf(undo),
      data: { broadcastId: undo.id, notified: false, overBudget: false },
    });
    return { ...base, outcome: 'updated' };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('broadcast.pass_failed', { broadcastId: undo.id, passId, code: error.code });
    return { ...base, outcome: error.code === 'BROADCAST_PASS_CHANGED' ? 'unchanged' : 'failed' };
  }
}

/**
 * After a pass the run could not write: when the run's creator no longer holds the right, the run
 * ends failed (`CREATOR_REVOKED`) instead of failing pass after pass. True when it ended.
 */
export async function endIfRevoked(ctx: ServiceContext, row: BroadcastRow): Promise<boolean> {
  if (await creatorIsActive(ctx.env.DB, row, ctx.clock.now())) return false;
  ctx.log.warn('broadcast.blocked', { broadcastId: row.id, code: 'CREATOR_REVOKED' });
  await casState(ctx.env.DB, row.id, ['sending'], 'failed', {
    finishedAt: ctx.clock.now(),
    errorCode: 'CREATOR_REVOKED',
  });
  return true;
}

/** One step of an undo: the next `REVERT_CHUNK` items of the run it restores. */
export async function revertChunk(
  ctx: ServiceContext,
  undo: BroadcastRow,
  parentId: string,
  cursor: string | null,
): Promise<{ nextCursor: string | null }> {
  const items = await revertItems(
    ctx.env.DB,
    parentId,
    undo.org_id,
    undo.mode,
    cursor,
    REVERT_CHUNK,
  );
  const done = await handledPassIds(
    ctx.env.DB,
    undo.id,
    items.map((i) => i.pass_id),
  );
  let restored = 0;
  for (const item of items) {
    if (done.has(item.pass_id)) continue;
    const result = await revertOne(ctx, undo, item.pass_id, item.before);
    if (result.outcome === 'failed' && (await endIfRevoked(ctx, undo))) return { nextCursor: null };
    await insertItems(ctx.env.DB, undo.id, [result]);
    if (result.outcome === 'updated') restored++;
  }
  if (restored > 0) await dispatchSafely(ctx);
  return { nextCursor: items.length === REVERT_CHUNK ? (items.at(-1)?.pass_id ?? null) : null };
}
