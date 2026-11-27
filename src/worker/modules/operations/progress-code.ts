import type { OperationStep } from '../../../shared/contracts/operations.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { kindOf } from './kinds.ts';
import type { Writer } from './progress-types.ts';
import { incrementStep } from './repo-write.ts';

const STABLE_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;

const MAX_CAUSE_DEPTH = 3;
/** The first frame of an Error's stack, as `dir/file:line:col`: where it was thrown, never what it held. */
const FRAME = /((?:[^\s/()\\]+\/)?[^\s/()\\]+:\d+:\d+)\)?$/;

/**
 * A stable code for what an error was, found without reading its message into a log: an own `code` (a
 * SigningError, a fetch or Node error), a D1 or SQLite code, then the same for its causes.
 */
function causeCodeOf(error: unknown, depth = 0): string | null {
  if (!(error instanceof Error) || depth >= MAX_CAUSE_DEPTH) return null;
  const own = (error as { code?: unknown }).code;
  if (typeof own === 'string' && STABLE_CODE.test(own)) return own;
  const d1 = classifyD1Error(error, { triggers: true });
  if (d1) return `D1_${d1.kind.toUpperCase()}`;
  const sqlite =
    /\bSQLITE_[A-Z_]+\b/.exec(error.message)?.[0] ?? /\bD1_[A-Z_]+\b/.exec(error.message)?.[0];
  if (sqlite) return sqlite;
  return causeCodeOf(error.cause, depth + 1);
}

function siteOf(error: unknown): string | null {
  if (!(error instanceof Error) || !error.stack) return null;
  // `stack` opens with `Name: message`, which can span lines: only what follows those lines is a frame.
  const frames = error.stack.split('\n').slice(error.message.split('\n').length);
  for (const line of frames) {
    const frame = line.trim();
    if (frame.startsWith('at ')) return FRAME.exec(frame)?.[1] ?? null;
  }
  return null;
}

/**
 * An AppError keeps its code; anything else is OPERATION_FAILED. Either way the failure is logged with the step it
 * stopped at, the error's class, a stable cause code and where it was thrown: never its message, which can carry
 * a holder's address or a field value.
 */
export function codeOf(
  ctx: ServiceContext,
  operationId: string,
  error: unknown,
  step: string | null,
): string {
  const known = error instanceof AppError && STABLE_CODE.test(error.code);
  const code = known ? error.code : 'OPERATION_FAILED';
  const fields = {
    code,
    operationId,
    step,
    cause: error instanceof Error ? error.name : 'unknown',
    causeCode: known ? error.code : causeCodeOf(error),
    site: siteOf(error),
  };
  if (known) ctx.log.warn('operation.failed', fields);
  else ctx.log.error('operation.failed', fields);
  return code;
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
