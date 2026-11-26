import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { continuationId, type SyncChain } from '../modules/connections/sync-chain.ts';
import { executeSync, type StepLike } from '../modules/connections/sync-runner.ts';
import type { AppEnv } from '../platform/env.ts';
import { createJobContext } from '../platform/service-context.ts';

export interface ConnectionSyncParams {
  /** Organization captured when the run was scheduled; never adopt a reassigned connection. */
  orgId: string;
  connectionId: string;
  generation: number;
  /** Credential reference keyset captured before the enqueue was committed. */
  credentialKeysetCommitment: string;
  trigger: 'schedule' | 'webhook' | 'admin';
  /** connection_runs id; defaults to the instance id. */
  runId?: string;
  /** Set on a continuation instance (id `<runId>-c<seq>`) started by a hand-off. */
  chain?: SyncChain;
  /** The operation that shows this run; absent for scheduled and webhook runs. */
  operationId?: string;
  operationAttempt?: number;
}

/** Instance id: sync-<connectionId>-<next_run_at>. Owner: connections module. */
export class ConnectionSync extends WorkflowEntrypoint<AppEnv, ConnectionSyncParams> {
  override async run(
    event: WorkflowEvent<ConnectionSyncParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const sctx = createJobContext(this.env, 'connection-sync', {
      ctx: this.ctx,
      base: { workflow: 'connection-sync' },
    });
    const adapter: StepLike = {
      do: (name, fn) => step.do(name, fn as never) as Promise<never>,
      sleep: (name, ms) => step.sleep(name, ms),
    };
    const runId = event.payload.runId ?? event.instanceId;
    const chain = event.payload.chain;
    // A continuation tracks under the run's first instance; any other id mismatch stays refused.
    const trackedAs =
      chain && event.instanceId === continuationId(runId, chain.seq) ? runId : event.instanceId;
    await executeSync(sctx, adapter, { ...event.payload, runId, instanceId: trackedAs });
  }
}
