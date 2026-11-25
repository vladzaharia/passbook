import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  applyChunk,
  type ChunkResult,
  type ImportRunParams,
} from '../modules/passes/import-apply.ts';
import { releaseHeldPage } from '../modules/passes/import-held.ts';
import { undoChunk } from '../modules/passes/import-undo-run.ts';
import { setWorkflowStatus } from '../modules/passes/repo.ts';
import {
  finishImport,
  progressOf,
  type Scope,
  skipErrorRows,
} from '../modules/passes/repo-import-commit.ts';
import { finishUndo } from '../modules/passes/repo-import-undo.ts';
import { getImport } from '../modules/passes/repo-imports.ts';
import type { AppEnv } from '../platform/env.ts';
import { AppError } from '../platform/errors.ts';
import { createJobContext } from '../platform/service-context.ts';

export type PassImportParams = ImportRunParams;

/** 2,000 rows at 5 a step is 400 chunks (402 steps of 10,000); the cap only stops a bug from looping. */
const MAX_CHUNKS = 410;
const STEP_RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } } as const;

type StepLike = Pick<WorkflowStep, 'do'> & Partial<Pick<WorkflowStep, 'sleep'>>;
type End = { state: 'done' | 'failed' | 'stale'; code: string | null };

/** Applies a checked import in chunks of 5 rows, each pass its own grant. Owner: passes module (imports). */
export async function runPassImport(
  env: AppEnv,
  instanceId: string,
  params: PassImportParams,
  step: StepLike,
  exec?: ExecutionContext,
): Promise<End> {
  const ctx = createJobContext(env, 'pass-import', {
    ...(exec ? { ctx: exec } : {}),
    base: { workflow: 'pass-import', instanceId },
  });
  const s: Scope = params;
  let end: End = { state: 'done', code: null };
  if (params.undo) return runUndo(ctx, instanceId, params, step);
  try {
    await step.do('start', async () => {
      await setWorkflowStatus(env.DB, instanceId, 'running', ctx.clock.now());
      const imp = await getImport(env.DB, params.orgId, params.mode, params.importId);
      if (imp?.state === 'committing') await skipErrorRows(ctx, s);
    });
    for (let n = 0; n < MAX_CHUNKS; n++) {
      const result: ChunkResult = await step.do(`chunk-${n}`, STEP_RETRY, () =>
        applyChunk(ctx, params),
      );
      if (result.revoked) end = { state: 'failed', code: 'IMPORT_STARTER_REVOKED' };
      else if (result.stale) end = { state: 'stale', code: 'IMPORT_STALE' };
      if (!result.more) break;
      if (n === MAX_CHUNKS - 1) end = { state: 'failed', code: 'IMPORT_TOO_LONG' };
    }
    await step.do('finish', async () => {
      const imp = await getImport(env.DB, params.orgId, params.mode, params.importId);
      const progress = await progressOf(env.DB, params.importId);
      const holdMs = end.state === 'done' ? (imp?.email_hold_ms ?? null) : null;
      await finishImport(
        ctx,
        s,
        { ...end, progress, ...(holdMs ? { holdUntil: ctx.clock.now() + holdMs } : {}) },
        imp ?? undefined,
      );
      await setWorkflowStatus(
        env.DB,
        instanceId,
        end.state === 'done' ? 'complete' : 'errored',
        ctx.clock.now(),
        end.code ?? (progress.failed > 0 ? 'PARTIAL_FAILURE' : null),
      );
      ctx.log.info('pass_import.done', {
        importId: params.importId,
        state: end.state,
        ...progress,
      });
    });
    await releaseHeld(ctx, params, step, end);
  } catch (error) {
    await step.do('fail', async () => {
      try {
        const imp = await getImport(env.DB, params.orgId, params.mode, params.importId);
        await finishImport(
          ctx,
          s,
          {
            state: 'failed',
            code: 'IMPORT_FAILED',
            progress: await progressOf(env.DB, params.importId),
          },
          imp ?? undefined,
        );
      } catch (inner) {
        // The import may already be finished; any other failure is left to the sweeper.
        if (!(inner instanceof AppError)) throw inner;
        ctx.log.warn('pass_import.fail_mark_lost', { importId: params.importId, code: inner.code });
      }
      await setWorkflowStatus(env.DB, instanceId, 'errored', ctx.clock.now(), 'IMPORT_FAILED');
    });
    throw error;
  }
  return end;
}

/** Held mail: wait out the undo window, then mail the created passes nobody undid, a page a step. */
async function releaseHeld(
  ctx: ReturnType<typeof createJobContext>,
  params: PassImportParams,
  step: StepLike,
  end: End,
): Promise<void> {
  const imp = await getImport(ctx.env.DB, params.orgId, params.mode, params.importId);
  if (end.state !== 'done' || !imp?.email_hold_ms || !step.sleep) return;
  // Step names `hold` and `release-N`, and their order, must not change while instances may be sleeping: a renamed step replays.
  await step.sleep('hold', imp.email_hold_ms);
  let after = 0;
  for (let n = 0; n < MAX_CHUNKS; n++) {
    const page = await step.do(`release-${n}`, STEP_RETRY, () =>
      releaseHeldPage(ctx, params, after),
    );
    if (page.next === null) break;
    after = page.next;
  }
}

/** An undo run: chunks of rows, then the finish. */
async function runUndo(
  ctx: ReturnType<typeof createJobContext>,
  instanceId: string,
  params: PassImportParams,
  step: StepLike,
): Promise<End> {
  let end: End = { state: 'done', code: null };
  await step.do('start', () =>
    setWorkflowStatus(ctx.env.DB, instanceId, 'running', ctx.clock.now()),
  );
  try {
    for (let n = 0; n < MAX_CHUNKS; n++) {
      const result = await step.do(`undo-${n}`, STEP_RETRY, () => undoChunk(ctx, params));
      if (result.revoked) end = { state: 'failed', code: 'IMPORT_STARTER_REVOKED' };
      if (!result.more) break;
    }
  } catch (error) {
    // A suspended org, or a write that keeps failing: end the undo as failed so it can be asked for again.
    ctx.log.warn('pass_import.undo_failed', {
      importId: params.importId,
      code: 'IMPORT_UNDO_FAILED',
      error,
    });
    end = { state: 'failed', code: 'IMPORT_UNDO_FAILED' };
  }
  await step.do('undo-finish', () =>
    finishUndo(ctx, params, end.state === 'done' ? undefined : (end.code ?? 'IMPORT_UNDO_FAILED')),
  );
  await step.do('close', () =>
    setWorkflowStatus(
      ctx.env.DB,
      instanceId,
      end.state === 'done' ? 'complete' : 'errored',
      ctx.clock.now(),
      end.code,
    ),
  );
  return end;
}

export class PassImport extends WorkflowEntrypoint<AppEnv, PassImportParams> {
  override async run(event: WorkflowEvent<PassImportParams>, step: WorkflowStep): Promise<void> {
    await runPassImport(this.env, event.instanceId, event.payload, step, this.ctx);
  }
}
