import type { ServiceContext } from '../../platform/service-context.ts';
import type { Totals } from './records.ts';
import { runSuperseded } from './repo-sync.ts';

/** The subset of WorkflowStep the runner needs; tests pass an inline implementation. */
export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

/** The run was replaced by a newer one (`SUPERSEDED`): it stops before its next step writes anything. */
export class RunSupersededError extends Error {}

/** Every step first checks the run's own tracking row, so a replaced run cannot move the cursor or health. */
export function guardRun(
  step: StepLike,
  sctx: ServiceContext,
  p: { instanceId: string; orgId: string; connectionId: string },
): StepLike {
  return {
    sleep: (name, ms) => step.sleep(name, ms),
    do: async (name, fn) => {
      if (await runSuperseded(sctx.env.DB, p)) throw new RunSupersededError();
      return step.do(name, fn);
    },
  };
}

export function add(into: Totals, from: Totals): void {
  into.seen += from.seen;
  into.changed += from.changed;
  into.created += from.created;
  into.missing += from.missing;
  into.errors += from.errors;
  if (from.voided) into.voided = (into.voided ?? 0) + from.voided;
}
