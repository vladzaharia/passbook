import type { ServiceContext } from '../../platform/service-context.ts';
import { commitSyncEnqueue } from './repo-sync.ts';
import type { StepLike, SyncRunParams } from './sync-runner.ts';

export {
  passRelease,
  replaceKeysetForTest,
  startPendingTransfer,
} from './repo-runtime-fixtures.ts';

/** Seed the same durable pair that a real connection enqueue commits. */
export async function seedConnectionWorkflow(ctx: ServiceContext, p: SyncRunParams) {
  if (
    p.runId !== p.instanceId ||
    !(await commitSyncEnqueue(
      ctx,
      {
        instanceId: p.instanceId,
        orgId: p.orgId,
        connectionId: p.connectionId,
        generation: p.generation,
        credentialKeysetCommitment: p.credentialKeysetCommitment,
        trigger: p.trigger,
        actorId: null,
        startedAt: ctx.clock.now(),
      },
      { orgId: p.orgId },
    ))
  )
    throw new Error('Could not seed connection workflow');
}

export function inlineStep(): StepLike & { names: string[]; sleeps: number[] } {
  const names: string[] = [];
  const sleeps: number[] = [];
  return {
    names,
    sleeps,
    do: async (name, fn) => {
      names.push(name);
      // Workflow steps persist JSON; round-trip to catch non-serializable results.
      const value = await fn();
      return value === undefined ? value : JSON.parse(JSON.stringify(value));
    },
    sleep: async (_name, ms) => {
      sleeps.push(ms);
    },
  };
}
