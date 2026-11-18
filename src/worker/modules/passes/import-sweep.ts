import type { ServiceContext } from '../../platform/service-context.ts';
import { finishRun } from '../../platform/workflow-runs.ts';
import { importInstanceId } from './import-commit.ts';
import { releaseImportEmail } from './import-email.ts';
import { finishImport, progressOf, stuckImports } from './repo-import-commit.ts';

const STUCK_AFTER = 10 * 60_000;
const BATCH = 20;
const LIVE = new Set(['queued', 'running', 'waiting', 'paused', 'waitingForPause']);

/**
 * Frees an import whose run died (an exhausted step, a terminated instance, a start that never reached
 * Workflows): it ends `failed` with its counters. A live instance is left alone, and a dead run is never
 * re-created: a new commit re-proves the starter.
 */
export async function sweepStuckImports(ctx: ServiceContext): Promise<void> {
  for (const imp of await stuckImports(ctx.env.DB, ctx.clock.now() - STUCK_AFTER, BATCH)) {
    const instanceId = imp.check_id ? importInstanceId(imp.id, imp.check_id) : null;
    let status: string | null = null;
    if (instanceId) {
      try {
        status = (await (await ctx.env.PASS_IMPORT.get(instanceId)).status()).status;
      } catch {
        // Workflows rejects for an id it does not know: the run never started.
        status = null;
      }
    }
    if (status !== null && LIVE.has(status)) continue;
    const scope = { orgId: imp.org_id, mode: imp.mode, importId: imp.id };
    try {
      await finishImport(ctx, scope, {
        state: 'failed',
        code: 'IMPORT_FAILED',
        progress: await progressOf(ctx.env.DB, imp.id),
      });
      await releaseImportEmail(ctx.env.DB, imp);
      if (instanceId)
        await finishRun(ctx.env.DB, instanceId, 'errored', ctx.clock.now(), {
          errorCode: 'IMPORT_FAILED',
        });
      ctx.log.warn('pass_import.swept', { importId: imp.id, code: 'IMPORT_FAILED', status });
    } catch (error) {
      ctx.log.error('pass_import.sweep_failed', { importId: imp.id, code: 'IMPORT_SWEEP', error });
    }
  }
}
