import type { OperationStep } from '../../../shared/contracts/operations.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { kindOf } from './kinds.ts';
import type { Writer } from './progress-types.ts';
import { incrementStep } from './repo-write.ts';

const STABLE_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;

/** An AppError keeps its code; anything else is OPERATION_FAILED and logged as an error. */
export function codeOf(ctx: ServiceContext, operationId: string, error: unknown): string {
  if (error instanceof AppError && STABLE_CODE.test(error.code)) return error.code;
  ctx.log.error('operation.failed', {
    code: 'OPERATION_FAILED',
    operationId,
    cause: error instanceof Error ? error.name : 'unknown',
  });
  return 'OPERATION_FAILED';
}

/** The end of a successful operation: running steps are done, tails wait by their date, pending ones are skipped. */
export function settleSteps(steps: OperationStep[], kind: string, now: number): void {
  for (const step of steps) {
    const tail = kindOf(kind)?.steps.find((d) => d.key === step.key)?.tail === true;
    if (tail && step.state !== 'done') {
      step.state = 'waiting';
      step.waitingReason = 'due';
    } else if (step.state === 'running' || step.state === 'waiting') {
      step.state = 'done';
      step.waitingReason = null;
    } else if (step.state === 'pending') step.state = 'skipped';
    else continue;
    if (step.state !== 'waiting') step.finishedAt = now;
  }
}

/** One more done in the database; the count (and total) it answers is what later writes of the step carry. */
export const tickStep = (
  ctx: ServiceContext,
  id: string,
  attempt: number,
  index: number,
  lease: Writer | null,
) => incrementStep(ctx.env.DB, { id, attempt, now: ctx.clock.now(), index, lease });
