import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { progressOf } from '../modules/operations/progress.ts';
import {
  type ReissuePageResult,
  type ReissueParams,
  reissuePage,
} from '../modules/passes/bulk-reissue-page.ts';
import { failBulkRun } from '../modules/passes/bulk-run.ts';
import { runBulkChunk } from '../modules/passes/bulk-run-chunk.ts';
import { setWorkflowStatus } from '../modules/passes/repo.ts';
import type { AppEnv } from '../platform/env.ts';
import { AppError } from '../platform/errors.ts';
import { createJobContext } from '../platform/service-context.ts';

export type BulkReissueParams = ReissueParams;
/** A bulk action over a snapshot of passes (`POST /passes/bulk-runs`): same workflow class, own params. */
export interface BulkActionParams {
  kind: 'bulk_action';
  runId: string;
}

const MAX_PAGES = 1000;
const PAGE_RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } } as const;

type StepLike = Pick<WorkflowStep, 'do'>;

/** Rebuild passes in chunks of 100 with CAS publish. Owner: passes module. */
export async function runBulkReissue(
  env: AppEnv,
  instanceId: string,
  params: BulkReissueParams,
  step: StepLike,
  exec?: ExecutionContext,
): Promise<{ changed: number; unchanged: number; failed: number; aboveMax?: number }> {
  const ctx = createJobContext(env, 'bulk-reissue', {
    ...(exec ? { ctx: exec } : {}),
    base: { workflow: 'bulk-reissue', instanceId },
  });
  const progress = progressOf(ctx, params.operationId, params.operationAttempt ?? 1);
  const starting = progress.step('start');
  await step.do('start', () => setWorkflowStatus(env.DB, instanceId, 'running', ctx.clock.now()));
  await starting.done();
  const counted = progress.step('passes');
  const totals: { changed: number; unchanged: number; failed: number; aboveMax?: number } = {
    changed: 0,
    unchanged: 0,
    failed: 0,
  };
  try {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const from: string | null = cursor;
      const result: ReissuePageResult = await step.do(`page-${page}`, PAGE_RETRY, () =>
        reissuePage(ctx, params, from),
      );
      totals.changed += result.changed;
      totals.unchanged += result.unchanged;
      totals.failed += result.failed;
      await counted.count(totals.changed + totals.unchanged + totals.failed);
      if (result.revoked) {
        await step.do('revoked', () =>
          setWorkflowStatus(
            env.DB,
            instanceId,
            'errored',
            ctx.clock.now(),
            'REISSUE_PRINCIPAL_REVOKED',
          ),
        );
        await progress.fail(
          new AppError('REISSUE_PRINCIPAL_REVOKED', 403, 'Your access to this run ended.'),
        );
        return totals;
      }
      if (result.aboveMax) totals.aboveMax = (totals.aboveMax ?? 0) + result.aboveMax;
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
  } catch (error) {
    await step.do('fail', () =>
      setWorkflowStatus(env.DB, instanceId, 'errored', ctx.clock.now(), 'BULK_REISSUE_FAILED'),
    );
    await progress.fail(new AppError('BULK_REISSUE_FAILED', 500, 'The rebuild stopped.'));
    throw error;
  }
  await counted.done();
  const finishing = progress.step('finish');
  await step.do('finish', async () => {
    await setWorkflowStatus(
      env.DB,
      instanceId,
      'complete',
      ctx.clock.now(),
      totals.failed > 0 ? 'PARTIAL_FAILURE' : null,
    );
    ctx.log.info('bulk_reissue.done', { ...totals, templateId: params.templateId });
  });
  await finishing.done();
  await progress.succeed({
    href: null,
    ids: {
      changed: String(totals.changed),
      unchanged: String(totals.unchanged),
      failed: String(totals.failed),
    },
  });
  return totals;
}

const MAX_CHUNKS = 1000;

/** One step per chunk; the run's own record holds the cursor, so a retried step resumes where it stopped. */
export async function runBulkAction(
  env: AppEnv,
  params: BulkActionParams,
  step: StepLike,
  exec?: ExecutionContext,
): Promise<void> {
  const ctx = createJobContext(env, 'bulk-action', {
    ...(exec ? { ctx: exec } : {}),
    base: { workflow: 'bulk-action', runId: params.runId },
  });
  try {
    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      const { more } = await step.do(`chunk-${chunk}`, PAGE_RETRY, () =>
        runBulkChunk(ctx, params.runId),
      );
      if (!more) return;
    }
    await step.do('too-long', () => failBulkRun(ctx, params.runId, 'BULK_RUN_TOO_LONG'));
  } catch (error) {
    await step.do('fail', () => failBulkRun(ctx, params.runId, 'BULK_RUN_FAILED'));
    throw error;
  }
}

export class BulkReissue extends WorkflowEntrypoint<AppEnv, BulkReissueParams | BulkActionParams> {
  override async run(
    event: WorkflowEvent<BulkReissueParams | BulkActionParams>,
    step: WorkflowStep,
  ): Promise<void> {
    if ('kind' in event.payload) await runBulkAction(this.env, event.payload, step, this.ctx);
    else await runBulkReissue(this.env, event.instanceId, event.payload, step, this.ctx);
  }
}
