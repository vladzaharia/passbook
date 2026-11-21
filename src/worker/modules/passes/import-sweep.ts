import type { ServiceContext } from '../../platform/service-context.ts';
import { finishRun } from '../../platform/workflow-runs.ts';
import { importInstanceId, instanceStatus } from './import-commit.ts';
import { finishImport, progressOf, stuckImports } from './repo-import-commit.ts';
import { finishUndo, stuckUndos } from './repo-import-undo.ts';

const STUCK_AFTER = 10 * 60_000;
const PAGE = 20;
const MAX_PAGES = 5;
/** Only these end a run for good. A live or unknown status leaves the import alone. */
const DEAD = new Set(['missing', 'errored', 'terminated', 'complete']);

/** An undo whose run died ends failed, so asking again goes through the whole start (window, authority, starter). */
async function sweepStuckUndos(ctx: ServiceContext): Promise<void> {
  for (const u of await stuckUndos(ctx.env.DB, ctx.clock.now() - STUCK_AFTER, PAGE)) {
    const status = u.undo_instance
      ? await instanceStatus(ctx, u.undo_instance, 'IMPORT_SWEEP_STATUS')
      : 'missing';
    if (!DEAD.has(status)) continue;
    try {
      await finishUndo(
        ctx,
        { orgId: u.org_id, mode: u.mode, importId: u.id },
        'IMPORT_UNDO_FAILED',
        u.undo_instance,
      );
      ctx.log.warn('pass_import.undo_swept', {
        orgId: u.org_id,
        importId: u.id,
        code: 'IMPORT_UNDO_FAILED',
        status,
      });
    } catch (error) {
      ctx.log.error('pass_import.sweep_failed', {
        orgId: u.org_id,
        importId: u.id,
        code: 'IMPORT_SWEEP',
        error,
      });
    }
  }
}

/**
 * Frees an import whose run died (an exhausted step, a terminated instance, a start that never reached
 * Workflows): it ends `failed` with its counters and its email hold given back. A live or unknown instance
 * is left alone, and a dead run is never re-created: a new commit re-proves the starter.
 */
export async function sweepStuckImports(ctx: ServiceContext): Promise<void> {
  await sweepStuckUndos(ctx);
  const before = ctx.clock.now() - STUCK_AFTER;
  let after: { at: number; id: string } | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const imports = await stuckImports(ctx.env.DB, before, PAGE, after);
    for (const imp of imports) {
      const instanceId = imp.check_id ? importInstanceId(imp.id, imp.check_id) : null;
      const status = instanceId
        ? await instanceStatus(ctx, instanceId, 'IMPORT_SWEEP_STATUS')
        : 'missing';
      if (!DEAD.has(status)) continue;
      try {
        await finishImport(
          ctx,
          { orgId: imp.org_id, mode: imp.mode, importId: imp.id },
          {
            state: 'failed',
            code: 'IMPORT_FAILED',
            progress: await progressOf(ctx.env.DB, imp.id),
          },
          imp,
        );
        if (instanceId)
          await finishRun(ctx.env.DB, instanceId, 'errored', ctx.clock.now(), {
            errorCode: 'IMPORT_FAILED',
          });
        ctx.log.warn('pass_import.swept', {
          orgId: imp.org_id,
          importId: imp.id,
          code: 'IMPORT_FAILED',
          status,
        });
      } catch (error) {
        ctx.log.error('pass_import.sweep_failed', {
          orgId: imp.org_id,
          importId: imp.id,
          code: 'IMPORT_SWEEP',
          error,
        });
      }
    }
    const last = imports[imports.length - 1];
    if (imports.length < PAGE || !last) return;
    after = { at: last.committed_at, id: last.id };
  }
}
