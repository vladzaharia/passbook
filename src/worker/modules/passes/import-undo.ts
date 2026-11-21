import type { PassImportDto } from '../../../shared/contracts/pass-imports.ts';
import { AppError, ConflictError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { startRun } from '../../platform/workflow-runs.ts';
import type { TenantPassWrite } from './http.ts';
import { instanceStatus, starterOf } from './import-commit.ts';
import { requireImport } from './import-service.ts';
import {
  beginUndo,
  failUndo,
  pendingMail,
  revertUndo,
  UNDO_DONE,
  UNDO_RUNNING,
  UNDOABLE,
  undoResultOf,
} from './repo-import-undo.ts';
import type { ImportRow } from './repo-imports.ts';

type UndoResult = NonNullable<PassImportDto['undo']>;

/** An import can be undone for a day after it ends; mail already sent is never recalled. */
export const UNDO_WINDOW_MS = 24 * 3_600_000;

/** One instance per ask: Workflows never reuse an id, and a re-ask after a failed run is a new run. */
export const undoInstanceId = (id: string, token: string) => `pass-import-undo-${id}-${token}`;

async function startUndoRun(
  ctx: ServiceContext,
  a: TenantPassWrite,
  imp: ImportRow,
  instanceId: string,
): Promise<boolean> {
  try {
    await startRun(
      ctx.env.DB,
      { instanceId, kind: 'pass_import', orgId: a.orgId, targetId: imp.id, now: ctx.clock.now() },
      { ignoreDuplicate: true },
    );
    await ctx.env.PASS_IMPORT.create({
      id: instanceId,
      params: { importId: imp.id, orgId: a.orgId, mode: a.mode, undo: true },
    });
    return true;
  } catch (error) {
    ctx.log.error('pass_import.undo_start_failed', {
      orgId: a.orgId,
      importId: imp.id,
      code: 'WORKFLOW_START_FAILED',
      error,
    });
    // An ambiguous failure may have created the instance: it then owns the undo.
    return (await instanceStatus(ctx, instanceId, 'IMPORT_UNDO_STATUS')) !== 'missing';
  }
}

/** Statuses that end a run for good. */
const DEAD = ['missing', 'errored', 'terminated', 'complete'];
/** A start that has not reached Workflows yet reads as missing for this long. */
const START_GRACE_MS = 60_000;

/**
 * Undoes an ended import as a workflow: created passes that nobody edited or scanned are removed, updated
 * passes get their earlier inputs back while still at the version the import wrote, held mail is cancelled.
 * Asking again returns the running or finished undo; a run that died ends failed, and the next ask goes
 * through the whole start again (window, authority, fresh starter). A running undo is never started twice.
 */
export async function undoImport(
  ctx: ServiceContext,
  a: TenantPassWrite,
  id: string,
): Promise<UndoResult> {
  let imp = await requireImport(ctx, a, id);
  const now = ctx.clock.now();
  if (imp.reverted === UNDO_RUNNING) {
    const status = imp.undo_instance
      ? await instanceStatus(ctx, imp.undo_instance, 'IMPORT_UNDO_STATUS')
      : 'missing';
    const young = status === 'missing' && now - (imp.undo_at ?? 0) < START_GRACE_MS;
    if (!DEAD.includes(status) || young) return undoResultOf(ctx.env.DB, imp);
    await failUndo(ctx, a, id);
    imp = await requireImport(ctx, a, id);
  }
  if (imp.reverted === UNDO_DONE) return undoResultOf(ctx.env.DB, imp);
  if (imp.state === 'committing') throw new ConflictError('This import is running.', 'IMPORT_BUSY');
  if (imp.committed_at === null || !UNDOABLE.includes(imp.state))
    throw new ConflictError('This import has nothing to undo.', 'IMPORT_STATE');
  if ((imp.finished_at ?? 0) + UNDO_WINDOW_MS <= now)
    throw new ConflictError(
      'An import can be undone for 24 hours after it ends.',
      'IMPORT_UNDO_EXPIRED',
    );
  const holding = imp.email_hold_until !== null && imp.email_hold_until > now;
  const instance = undoInstanceId(id, ctx.ids.id());
  try {
    await beginUndo(ctx, a, id, {
      starter: await starterOf(ctx, a),
      cancelled: holding ? await pendingMail(ctx.env.DB, id) : 0,
      instance,
    });
  } catch (error) {
    // The loser of two first asks finds the winner's undo, not a stale state.
    const now2 = await requireImport(ctx, a, id);
    if (error instanceof AppError && now2.reverted !== 0) return undoResultOf(ctx.env.DB, now2);
    throw error;
  }
  if (!(await startUndoRun(ctx, a, imp, instance))) {
    await revertUndo(ctx, a, id);
    throw new UnavailableError('The undo did not start. Try again.', 'WORKFLOW_START');
  }
  return undoResultOf(ctx.env.DB, await requireImport(ctx, a, id));
}
