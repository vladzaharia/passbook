import { formatClock, formatShortDateIn, formatSpan } from '../../lib/format.ts';
import type { OperationStep, OperationStepState } from './types.ts';

/** The kit's marker for each API step state. */
export const MARKER = {
  pending: 'todo',
  running: 'working',
  waiting: 'waiting',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
} as const satisfies Record<OperationStepState, string>;

/** "4 of 12", which also reads well aloud. */
export const countText = (step: Pick<OperationStep, 'done' | 'total'>): string | null =>
  step.total !== null && step.total > 0 ? `${step.done ?? 0} of ${step.total}` : null;

/**
 * The line for a running step: its `active` words alone, then `active · 4 of 12` once there is a
 * count. A waiting tail reads `label · By Dec 2`.
 */
export function stepText(
  step: Pick<OperationStep, 'done' | 'total' | 'until' | 'state'> & { label: string },
  active: string | undefined,
  zone?: string,
): string {
  if (step.state === 'waiting' && step.until !== null)
    return `${step.label} · By ${formatShortDateIn(step.until, zone)}`;
  const count = countText(step);
  return count ? `${active ?? step.label} · ${count}` : (active ?? step.label);
}

/** The muted meta on a step row: its count, or when a waiting step resumes (a tail: its date). */
export function stepMeta(
  step: OperationStep,
  now: number,
  zone?: string,
  tail = false,
): string | undefined {
  if (step.state === 'waiting' && step.until !== null)
    return tail
      ? `By ${formatShortDateIn(step.until, zone)}`
      : `Tries again in ${formatSpan(step.until - now)}`;
  if (step.state === 'pending' || (step.state === 'skipped' && !step.done)) return undefined;
  return countText(step) ?? undefined;
}

/** Elapsed from the first start; frozen at the end. */
export function elapsedMs(
  op: { startedAt: number | null; createdAt: number; finishedAt: number | null },
  now: number,
): number {
  return Math.max(0, (op.finishedAt ?? now) - (op.startedAt ?? op.createdAt));
}

export { formatClock };
