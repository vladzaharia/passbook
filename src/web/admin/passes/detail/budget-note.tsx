import type { PushBudgetDto } from '@/shared/contracts/passes.ts';
import { formatDateTime } from '../../../lib/format.ts';
import { Callout } from '../../../ui/index.ts';

/** Shown when a save would notify a pass that already used its daily notifications. */
export function BudgetNote({ budget, show }: { budget: PushBudgetDto; show: boolean }) {
  if (!show || budget.used < budget.limit) return null;
  return (
    <Callout tone="warning">
      This pass has had {budget.used} of {budget.limit} notifications today. The save updates it
      without one
      {budget.resetsAt ? `. The next opens ${formatDateTime(budget.resetsAt)}.` : '.'}
    </Callout>
  );
}
