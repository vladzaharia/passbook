import {
  type BroadcastState,
  BroadcastTargetSchema,
} from '../../../shared/contracts/broadcasts.ts';
import { changeRunDrifted } from '../../../shared/contracts/pass-selection.ts';
import { jobGrant } from '../../platform/authority.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { finishRun } from '../../platform/workflow-runs.ts';
import { actorOf, failInvalidTarget, safeTargetFilter } from './apply.ts';
import { settlePending } from './change-intent.ts';
import { snapshotTargets } from './change-snapshot.ts';
import { countsOf } from './dto.ts';
import {
  type BroadcastRow,
  casState,
  countItems,
  getBroadcast,
  insertBroadcastStmt,
  setTargeted,
} from './repo.ts';
import { creatorLive } from './repo-creator.ts';
import { countRevertable } from './repo-items.ts';
import { importTemplate, markSnapshot } from './repo-selection.ts';
import { countTargeted } from './repo-target.ts';
import { StoredBroadcastTargetSchema } from './stored-target.ts';

/** First workflow step: counts the target. False when the broadcast cannot be sent (cancelled, already settled). */
export async function startedBroadcast(
  ctx: ServiceContext,
  instanceId: string,
  broadcastId: string,
): Promise<boolean> {
  let row = await getBroadcast(ctx.env.DB, broadcastId, null);
  // A launch that looked failed (the create call errored) may revert to scheduled while this
  // instance runs: take over instead of skipping.
  if (row?.state === 'scheduled') {
    await casState(ctx.env.DB, broadcastId, ['scheduled'], 'sending', {
      startedAt: ctx.clock.now(),
    });
    row = await getBroadcast(ctx.env.DB, broadcastId, null);
  }
  if (row?.state !== 'sending') {
    await finishRun(ctx.env.DB, instanceId, 'complete', ctx.clock.now());
    return false;
  }
  const filter = safeTargetFilter(row, null, 1);
  if (!filter) {
    await failInvalidTarget(ctx, row);
    await finishRun(ctx.env.DB, instanceId, 'errored', ctx.clock.now(), {
      errorCode: 'BROADCAST_TARGET_INVALID',
    });
    return false;
  }
  const stored = StoredBroadcastTargetSchema.parse(JSON.parse(row.target));
  const refuse = async (code: string) => {
    ctx.log.warn('broadcast.blocked', { broadcastId, code });
    await casState(ctx.env.DB, broadcastId, ['sending'], 'failed', {
      finishedAt: ctx.clock.now(),
      errorCode: code,
    });
    await finishRun(ctx.env.DB, instanceId, 'errored', ctx.clock.now(), { errorCode: code });
    return false;
  };
  if (row.kind === 'change' && !stored.revertOf && !stored.selection?.match(/^(ids|resume)$/)) {
    // What a filter or an import matched is fixed once the run starts: its passes are snapshotted, so
    // later pages cannot pick up passes created after the count (and an import still running is refused).
    if (stored.importId) {
      const imp = await importTemplate(ctx.env.DB, stored.importId, row.org_id, row.mode);
      if (!imp?.ended) return refuse('IMPORT_NOT_ENDED');
    }
    // A start that died partway redoes the snapshot (adding is idempotent); done only after its last page.
    if (row.snapshot_at === null) {
      if (!(await snapshotTargets(ctx, row))) return refuse('MATCH_TOO_BROAD');
      await markSnapshot(ctx.env.DB, broadcastId, ctx.clock.now());
    }
  }
  const targeted = stored.revertOf
    ? await countRevertable(ctx.env.DB, stored.revertOf, row.org_id, row.mode)
    : await countTargeted(ctx.env.DB, filter, ctx.clock.now());
  // The admin confirmed a count; a selection that moved since (a schedule, a retry) applies nothing.
  if (stored.expectCount !== undefined && changeRunDrifted(stored.expectCount, targeted))
    return refuse('SELECTION_CHANGED');
  await setTargeted(ctx.env.DB, broadcastId, targeted);
  await finishRun(ctx.env.DB, instanceId, 'running', ctx.clock.now());
  return true;
}

function endState(counts: ReturnType<typeof countsOf>): BroadcastState {
  if (counts.failed === 0) return 'sent';
  return counts.updated + counts.unchanged > 0 ? 'partial' : 'failed';
}

/** The follow-up that clears a message `clearAfter` ms after the send started. */
async function scheduleClear(ctx: ServiceContext, row: BroadcastRow): Promise<void> {
  if (row.kind !== 'message' || !row.clear_after) return;
  const patch = JSON.parse(row.patch) as { message?: string };
  const at = Math.max((row.started_at ?? ctx.clock.now()) + row.clear_after, ctx.clock.now());
  await insertBroadcastStmt(ctx.env.DB, {
    id: ctx.ids.id(),
    orgId: row.org_id,
    mode: row.mode,
    kind: 'message',
    name: `Clear: ${row.name}`.slice(0, 80),
    state: 'scheduled',
    // A rule run clears only the passes it updated, not the window it targeted.
    target: row.rule_id
      ? {
          templateIds: BroadcastTargetSchema.parse(JSON.parse(row.target)).templateIds,
          sentBy: row.id,
        }
      : JSON.parse(row.target),
    patch: { message: '' },
    notify: false,
    at,
    clearAfter: null,
    expect: { message: patch.message ?? '' },
    parentId: row.id,
    ruleId: row.rule_id,
    actor: actorOf(row),
    now: ctx.clock.now(),
  }).run();
}

/** Last step: settles the state from the per-pass outcomes. `errorCode` marks a failed run. */
export async function finishBroadcast(
  ctx: ServiceContext,
  instanceId: string,
  broadcastId: string,
  errorCode: string | null = null,
): Promise<BroadcastState> {
  const row = await getBroadcast(ctx.env.DB, broadcastId, null);
  if (!row) return 'failed';
  // Whatever ended the run, a pass written whose item was not recorded is settled first.
  if (row.kind === 'change') await settlePending(ctx, row);
  const counts = countsOf(row, await countItems(ctx.env.DB, [broadcastId], row.org_id, row.mode));
  // A stop asked for while sending ends the run as cancelled, after its last chunk.
  const stopped = !errorCode && row.stop_at !== null;
  const state = errorCode ? 'failed' : stopped ? 'cancelled' : endState(counts);
  const now = ctx.clock.now();
  const won = await casState(ctx.env.DB, broadcastId, ['sending'], state, {
    finishedAt: now,
    errorCode: stopped ? 'BROADCAST_STOPPED' : errorCode,
  });
  if (won) ctx.log.info('broadcast.done', { broadcastId, state, ...counts });
  // A retry after a failed follow-up insert loses the CAS but still owes the follow-up; the
  // unique parent index makes the insert idempotent.
  const settled = won ? state : row.state;
  // A stopped message that reached some passes still clears them.
  if (settled === 'sent' || settled === 'partial' || (stopped && counts.updated > 0))
    await scheduleClear(ctx, row);
  await finishRun(ctx.env.DB, instanceId, errorCode ? 'errored' : 'complete', now, {
    errorCode:
      errorCode ?? (stopped ? 'BROADCAST_STOPPED' : state === 'sent' ? null : 'PARTIAL_FAILURE'),
  });
  return state;
}

/**
 * Runs before each send step (a `job` grant, no writes): the org is still active and the creator is
 * still live. Otherwise the run stops as failed; a cancelled broadcast is never picked up again.
 * Returns false when the broadcast must not send.
 */
export async function sendStepAllowed(ctx: ServiceContext, broadcastId: string): Promise<boolean> {
  const row = await getBroadcast(ctx.env.DB, broadcastId, null);
  if (row?.state !== 'sending' || row.stop_at !== null) return false;
  try {
    await jobGrant(ctx, {
      purpose: 'org_mode.job.broadcast.send',
      job: 'broadcast',
      orgId: row.org_id,
      mode: row.mode,
      target: broadcastId,
      checks: [creatorLive(row, ctx.clock.now())],
    }).commit();
    return true;
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    const code = error.code === 'ORG_ACCESS_CHANGED' ? 'ORG_INACTIVE' : 'CREATOR_REVOKED';
    ctx.log.warn('broadcast.blocked', { broadcastId, code });
    await casState(ctx.env.DB, broadcastId, ['sending'], 'failed', {
      finishedAt: ctx.clock.now(),
      errorCode: code,
    });
    return false;
  }
}
