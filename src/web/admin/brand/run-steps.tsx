import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { StepList, type StepListItem } from '@/web/ui/index.ts';

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
