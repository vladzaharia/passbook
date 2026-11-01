import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { type ReissuePageResult, type ReissueParams, reissuePage } from '../modules/passes/bulk.ts';
import { setWorkflowStatus } from '../modules/passes/repo.ts';
import type { AppEnv } from '../platform/env.ts';
import { createServiceContext } from '../platform/service-context.ts';

export type BulkReissueParams = ReissueParams;

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
): Promise<{ changed: number; unchanged: number; failed: number }> {
  const ctx = createServiceContext(env, {
    ...(exec ? { ctx: exec } : {}),
    base: { workflow: 'bulk-reissue', instanceId },
  });
  await step.do('start', () => setWorkflowStatus(env.DB, instanceId, 'running', ctx.clock.now()));
  const totals = { changed: 0, unchanged: 0, failed: 0 };
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
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
  } catch (error) {
    await step.do('fail', () =>
      setWorkflowStatus(env.DB, instanceId, 'errored', ctx.clock.now(), 'BULK_REISSUE_FAILED'),
    );
    throw error;
  }
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
  return totals;
}

export class BulkReissue extends WorkflowEntrypoint<AppEnv, BulkReissueParams> {
  override async run(event: WorkflowEvent<BulkReissueParams>, step: WorkflowStep): Promise<void> {
    await runBulkReissue(this.env, event.instanceId, event.payload, step, this.ctx);
  }
}
