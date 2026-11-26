import type { ServiceContext } from '../../platform/service-context.ts';
import type { Totals } from './records.ts';
import { runSuperseded } from './repo-sync.ts';

/** The subset of WorkflowStep the runner needs; tests pass an inline implementation. */
export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
  /** Set by the run guard: start checking the tracking row (the run's connector can be replaced mid-run). */
  arm?(): void;
}

/** The run was replaced by a newer one (`SUPERSEDED`): it stops before its next step writes anything. */
export class RunSupersededError extends Error {}

/**
 * Once armed, every step first checks the run's own tracking row, so a replaced run cannot move the cursor
 * or health. Only runs of a connector whose source changes under them (uploads) arm it: others pay no trips.
 */
export function guardRun(
  step: StepLike,
  sctx: ServiceContext,
  p: { instanceId: string; orgId: string; connectionId: string },
): StepLike {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    sleep: (name, ms) => step.sleep(name, ms),
    do: async (name, fn) => {
      if (armed && (await runSuperseded(sctx.env.DB, p))) throw new RunSupersededError();
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
