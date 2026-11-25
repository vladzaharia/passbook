import type { WorkflowStepConfig } from 'cloudflare:workers';
import type { Progress, StepHandle } from './progress.ts';

/** The part of a Workflow `step` that `tracked` uses. */
export interface StepLike {
  do<T extends Rpc.Serializable<T>>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T extends Rpc.Serializable<T>>(
    name: string,
    config: WorkflowStepConfig,
    callback: () => Promise<T>,
  ): Promise<T>;
}

/**
 * A user-visible `step.do`. The step starts and ends inside the callback, so a replay of a finished
 * step (its result comes from the journal) runs nothing and writes nothing, and a re-run of one the
 * operation already finished is ignored by the reporter.
 */
export function tracked<T extends Rpc.Serializable<T>>(
  step: StepLike,
  name: string,
  progress: Progress,
  key: string,
  fn: (handle: StepHandle) => Promise<T>,
  config?: WorkflowStepConfig,
): Promise<T> {
  const body = async () => {
    const handle = progress.step(key);
    const out = await fn(handle);
    await handle.done();
    return out;
  };
  return config ? step.do(name, config, body) : step.do(name, body);
}
