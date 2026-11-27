import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { StepList, type StepListItem } from '@/web/ui/index.ts';

/** Which of the four run steps is current, from the workflow's step name. */
export function stepIndex(step: string | null): number {
  if (!step) return 0;
  if (/finish|done/.test(step)) return 4;
  if (/push|apns/.test(step)) return 3;
  if (/cert|csr|issue/.test(step)) return 2;
  if (/type|identifier|create/.test(step)) return 1;
  return 0;
}

/**
 * A run as steps: done ones tick, the current one spins (or shows the failure), the rest wait.
 * Apple's managed ID and Google's managed issuer draw the same list.
 */
export function RunSteps({
  labels,
  at,
  failed,
}: {
  labels: readonly string[];
  /** Index of the current step; the length means every step is done. */
  at: number;
  failed: boolean;
}) {
  const items: StepListItem[] = labels.map((label, i) => ({
    id: label,
    label,
    state: i < at ? 'done' : i === at ? (failed ? 'failed' : 'working') : 'todo',
    ...(i === at && failed ? { detail: PASS_SETUP_COPY.channelsCard.runFailed } : {}),
  }));
  return <StepList items={items} label="Setup steps" />;
}
