import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { executeSync, type StepLike } from '../modules/connections/sync-runner.ts';
import type { AppEnv } from '../platform/env.ts';
import { createServiceContext } from '../platform/service-context.ts';

export interface ConnectionSyncParams {
  connectionId: string;
  generation: number;
  trigger: 'schedule' | 'webhook' | 'admin';
  /** connection_runs id; defaults to the instance id. */
  runId?: string;
}

/** Instance id: sync-<connectionId>-<next_run_at>. Owner: connections module. */
export class ConnectionSync extends WorkflowEntrypoint<AppEnv, ConnectionSyncParams> {
  override async run(
    event: WorkflowEvent<ConnectionSyncParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const sctx = createServiceContext(this.env, {
      ctx: this.ctx,
      base: { workflow: 'connection-sync' },
    });
    const adapter: StepLike = {
      do: (name, fn) => step.do(name, fn as never) as Promise<never>,
      sleep: (name, ms) => step.sleep(name, ms),
    };
    await executeSync(sctx, adapter, {
      ...event.payload,
      runId: event.payload.runId ?? event.instanceId,
      instanceId: event.instanceId,
    });
  }
}
