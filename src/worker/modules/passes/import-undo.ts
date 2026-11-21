import type { PassImportDto } from '../../../shared/contracts/pass-imports.ts';
import { ConflictError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { startRun } from '../../platform/workflow-runs.ts';
import type { TenantPassWrite } from './http.ts';
import { instanceStatus, starterOf } from './import-commit.ts';
import { requireImport } from './import-service.ts';
import {
  beginUndo,
  pendingMail,
  revertUndo,
  UNDO_DONE,
  UNDO_FAILED,
  UNDO_RUNNING,
  UNDOABLE,
  undoResultOf,
} from './repo-import-undo.ts';
import type { ImportRow } from './repo-imports.ts';

type UndoResult = NonNullable<PassImportDto['undo']>;

/** An import can be undone for a day after it ends; mail already sent is never recalled. */
export const UNDO_WINDOW_MS = 24 * 3_600_000;
/** Instance states of an undo run that still owns the work. */
const LIVE = ['queued', 'running', 'waiting', 'paused', 'waitingForPause', 'unknown'];

export const undoInstanceId = (id: string, restart?: number) =>
  `pass-import-undo-${id}${restart === undefined ? '' : `-${restart}`}`;

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

/**
 * Undoes an ended import as a workflow: created passes that nobody edited or scanned are removed, updated
 * passes get their earlier inputs back while still at the version the import wrote, held mail is cancelled.
 * Asking again returns the running or finished undo; a run whose workflow died is started again.
 */
export async function undoImport(
  ctx: ServiceContext,
  a: TenantPassWrite,
  id: string,
): Promise<UndoResult> {
  const imp = await requireImport(ctx, a, id);
  const now = ctx.clock.now();
  if (imp.reverted === UNDO_DONE) return undoResultOf(ctx.env.DB, imp);
  if (imp.reverted === UNDO_RUNNING) {
    const status = await instanceStatus(ctx, undoInstanceId(imp.id), 'IMPORT_UNDO_STATUS');
    if (LIVE.includes(status)) return undoResultOf(ctx.env.DB, imp);
    if (status === 'complete' || (await startUndoRun(ctx, a, imp, undoInstanceId(imp.id, now))))
      return undoResultOf(ctx.env.DB, imp);
    throw new UnavailableError('The undo did not start. Try again.', 'WORKFLOW_START');
  }
  if (imp.state === 'committing') throw new ConflictError('This import is running.', 'IMPORT_BUSY');
  if (imp.committed_at === null || !UNDOABLE.includes(imp.state))
    throw new ConflictError('This import has nothing to undo.', 'IMPORT_STATE');
  if ((imp.finished_at ?? 0) + UNDO_WINDOW_MS <= now)
    throw new ConflictError(
      'An import can be undone for 24 hours after it ends.',
      'IMPORT_UNDO_EXPIRED',
    );
  const holding = imp.email_hold_until !== null && imp.email_hold_until > now;
  await beginUndo(ctx, a, id, {
    starter: await starterOf(ctx, a),
    cancelled: holding ? await pendingMail(ctx.env.DB, id) : 0,
  });
  if (
    !(await startUndoRun(
      ctx,
      a,
      imp,
      undoInstanceId(id, imp.reverted === UNDO_FAILED ? now : undefined),
    ))
  ) {
    await revertUndo(ctx, a, id);
    throw new UnavailableError('The undo did not start. Try again.', 'WORKFLOW_START');
  }
  return undoResultOf(ctx.env.DB, await requireImport(ctx, a, id));
}
