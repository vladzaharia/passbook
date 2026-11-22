import type { z } from 'zod';
import type { BroadcastDto } from '../../../shared/contracts/broadcasts.ts';
import {
  type BroadcastUndoResultSchema,
  CHANGE_RUN_UNDO_MS,
  changeActionOf,
} from '../../../shared/contracts/broadcasts-change.ts';
import { batch } from '../../platform/db.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { Actor } from '../passes/service.ts';
import { settlePending } from './change-intent.ts';
import { assertCanChange, type BroadcastScope, requireWritableBroadcast } from './guards.ts';
import * as repo from './repo.ts';
import { countRevertable } from './repo-items.ts';
import {
  childOf,
  restartUndoStmt,
  stopBroadcastStmt,
  UNDOABLE_STATES,
  undoParentWhere,
} from './repo-undo.ts';
import { getBroadcastDto } from './service.ts';
import { launchBroadcast } from './start.ts';

type UndoResult = z.infer<typeof BroadcastUndoResultSchema>;

/** The undo as the caller reads it: restorable is the run's updates, less what the undo has found changed. */
async function resultOf(
  ctx: ServiceContext,
  parent: repo.BroadcastRow,
  child: repo.BroadcastRow,
): Promise<UndoResult> {
  const [written, childItems] = await Promise.all([
    countRevertable(ctx.env.DB, parent.id, parent.org_id, parent.mode),
    repo.countItems(ctx.env.DB, [child.id], child.org_id, child.mode),
  ]);
  const kept = childItems.filter((c) => c.outcome !== 'updated').reduce((sum, c) => sum + c.n, 0);
  return {
    id: child.id,
    parentId: parent.id,
    restorable: Math.max(0, written - kept),
    kept,
  };
}

/**
 * Undoes a finished change run for 24 hours: a silent child run puts each pass's touched inputs back,
 * but only while they still hold the value the run wrote. One undo per run (the unique parent
 * index). Asking again returns it, and an undo that ended on an error runs again as the same child.
 * A run that is still sending must be stopped first, so nothing is written under the undo.
 */
export async function undoBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  scope: BroadcastScope,
): Promise<UndoResult> {
  const parent = await requireWritableBroadcast(ctx, id, scope);
  assertCanChange(scope, 'change');
  if (parent.kind !== 'change' || parent.parent_id !== null)
    throw new ConflictError('Only a change can be undone.', 'BROADCAST_NOT_UNDOABLE');
  if (changeActionOf(JSON.parse(parent.patch)) === 'design')
    throw new ConflictError(
      'A move to the latest design cannot be undone. Roll the template back instead.',
      'BROADCAST_NOT_UNDOABLE',
    );
  const now = ctx.clock.now();
  const db = ctx.env.DB;
  const existing = await childOf(db, id, parent.org_id, parent.mode);
  if (existing) {
    const dead =
      (existing.state === 'failed' && existing.error_code !== null) ||
      (existing.state === 'cancelled' && existing.error_code === 'BROADCAST_STOPPED');
    if (!dead) return resultOf(ctx, parent, existing);
    const instance = `broadcast-${existing.id}-${ctx.ids.token()}`;
    const [restarted] = await batch(db, [
      restartUndoStmt(
        db,
        { id: existing.id, parent_id: id },
        actor,
        instance,
        scope.authority,
        now,
      ),
    ]);
    if ((restarted?.meta.changes ?? 0) === 1) {
      await audit(ctx, actor, parent, existing.id, true);
      await launchBroadcast(ctx, existing);
    }
    const now2 = await repo.getBroadcast(db, existing.id, null);
    return resultOf(ctx, parent, now2 ?? existing);
  }
  if (!(UNDOABLE_STATES as readonly string[]).includes(parent.state))
    throw new ConflictError(
      parent.state === 'sending' || parent.state === 'scheduled'
        ? 'This change is still running. Stop it first.'
        : 'This change was never sent.',
      'BROADCAST_NOT_UNDOABLE',
    );
  if ((parent.finished_at ?? 0) + CHANGE_RUN_UNDO_MS <= now)
    throw new ConflictError(
      'A change can be undone for 24 hours after it ends.',
      'BROADCAST_UNDO_EXPIRED',
    );
  await settlePending(ctx, parent);
  const childId = ctx.ids.id();
  const stored = JSON.parse(parent.target) as { templateIds: string[] };
  const [inserted] = await batch(db, [
    repo.insertAuthorizedBroadcastStmt(
      db,
      {
        id: childId,
        orgId: parent.org_id,
        mode: parent.mode,
        kind: 'change',
        name: `Undo: ${parent.name}`.slice(0, 80),
        state: 'scheduled',
        target: { templateIds: stored.templateIds, revertOf: id },
        patch: {},
        notify: false,
        at: now,
        clearAfter: null,
        parentId: id,
        actor: { type: actor.type, id: actor.id },
        now,
      },
      scope.authority,
      now,
      undoParentWhere(id, parent.org_id, parent.mode, now),
    ),
  ]);
  if ((inserted?.meta.changes ?? 0) !== 1) {
    // A second ask won the unique parent index, or the run changed or the authority lapsed.
    const winner = await childOf(db, id, parent.org_id, parent.mode);
    if (winner) return resultOf(ctx, parent, winner);
    const fresh = await repo.getBroadcast(db, id, null);
    if (fresh && (UNDOABLE_STATES as readonly string[]).includes(fresh.state))
      throw new ForbiddenError();
    throw new ConflictError('This change can no longer be undone.', 'BROADCAST_NOT_UNDOABLE');
  }
  await audit(ctx, actor, parent, childId, false);
  const child = await repo.getBroadcast(db, childId, null);
  if (!child) throw new ForbiddenError();
  await launchBroadcast(ctx, child);
  return resultOf(ctx, parent, (await repo.getBroadcast(db, childId, null)) ?? child);
}

async function audit(
  ctx: ServiceContext,
  actor: Actor,
  parent: repo.BroadcastRow,
  undoId: string,
  restart: boolean,
): Promise<void> {
  await recordAudit(ctx, {
    orgId: parent.org_id,
    actorType: actor.type,
    actorId: actor.id,
    action: 'broadcast.undo',
    targetType: 'broadcast',
    targetId: parent.id,
    detail: { undoId, restart },
  });
}

/**
 * Asks a sending run to end after its chunk: the workflow stops at its next gate and settles the run
 * as cancelled. Asking twice is the same ask.
 */
export async function stopBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  scope: BroadcastScope,
): Promise<BroadcastDto> {
  const row = await requireWritableBroadcast(ctx, id, scope);
  assertCanChange(scope, row.kind);
  const [stopped] = await batch(ctx.env.DB, [
    stopBroadcastStmt(ctx.env.DB, id, row.kind, scope.authority, ctx.clock.now()),
  ]);
  if ((stopped?.meta.changes ?? 0) !== 1) {
    const fresh = await repo.getBroadcast(ctx.env.DB, id, null);
    if (fresh?.state === 'sending') throw new ForbiddenError();
    throw new ConflictError('Only a sending message can be stopped.', 'BROADCAST_NOT_SENDING');
  }
  await recordAudit(ctx, {
    orgId: row.org_id,
    actorType: actor.type,
    actorId: actor.id,
    action: 'broadcast.stop',
    targetType: 'broadcast',
    targetId: id,
  });
  return getBroadcastDto(ctx, id, scope);
}
