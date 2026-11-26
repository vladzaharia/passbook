import type { OperationStep } from '../contracts/operations.ts';
import { DEFAULT_TIME_ZONE } from '../time-zone.ts';
import type { OperationStepDef } from './define.ts';

const byDate = (ms: number, zone: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: zone }).format(ms);

/**
 * The line a step shows. `active` alone while there is no count; `active · done of total` once there is (`active · done` while the total is unknown);
 * `label · By {date}` for a waiting step with an end date. A step with no `active` text shows its label.
 */
export function stepText(
  step: Pick<
    OperationStep,
    'state' | 'done' | 'total' | 'until' | 'label' | 'waitingReason' | 'detail'
  >,
  def?: Pick<OperationStepDef, 'active'>,
  zone: string = DEFAULT_TIME_ZONE,
): string {
  const head = def?.active ?? step.label;
  if (step.state === 'waiting' && step.waitingReason === 'due' && step.until !== null)
    return `${step.label} · By ${byDate(step.until, zone)}`;
  // Blocked: the step's own words, such as "Waiting for Apple".
  if (step.state === 'waiting' && step.waitingReason === 'blocked' && step.detail)
    return step.detail;
  if (step.done !== null && step.total !== null && step.state !== 'pending')
    return `${head} · ${step.done} of ${step.total}`;
  // A count with no known end (a listing of unknown length): "Rebuilding passes · 300".
  if (step.done !== null && step.done > 0 && step.total === null && step.state === 'running')
    return `${head} · ${step.done}`;
  return head;
}
