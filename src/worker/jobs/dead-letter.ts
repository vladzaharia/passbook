import { isActive } from '../modules/operations/dto.ts';
import { progressOf } from '../modules/operations/progress.ts';
import { rowById } from '../modules/operations/repo.ts';
import { recordDlqOutcome } from '../modules/status/repo-hooks.ts';
import { AppError } from '../platform/errors.ts';
import type { ServiceContext } from '../platform/service-context.ts';
import type { Job } from './types.ts';

/**
 * A job that will never run again must leave a terminal, visible outcome: the operation it served
 * ends failed (DEAD_LETTER) instead of staying pending, and the drop is kept for Status.
 */
export async function settleDroppedJob(
  ctx: ServiceContext,
  job: Job | null,
  messageId: string,
  code: string,
): Promise<void> {
  const operationId = job && 'operationId' in job ? job.operationId : undefined;
  if (operationId) {
    const row = await rowById(ctx.env.DB, operationId);
    if (row && isActive(row.status))
      await progressOf(ctx, row.id, row.attempt).fail(
        new AppError('DEAD_LETTER', 500, 'The job was dropped after its retries.'),
      );
  }
  const now = ctx.clock.now();
  await recordDlqOutcome(ctx.env.DB, {
    messageId,
    jobKind: job?.kind ?? 'invalid',
    orgId: job && 'orgId' in job ? job.orgId : null,
    targetId: operationId ?? null,
    code,
    at: now,
  });
}
