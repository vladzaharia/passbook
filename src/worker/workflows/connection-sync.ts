import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { AppEnv } from '../platform/env.ts';
import { NotImplementedError } from '../platform/errors.ts';

export interface ConnectionSyncParams {
  connectionId: string;
  generation: number;
  trigger: 'schedule' | 'webhook' | 'admin';
}

/** Instance id: sync-<connectionId>-<next_run_at>. Owner: connections module. */
export class ConnectionSync extends WorkflowEntrypoint<AppEnv, ConnectionSyncParams> {
  override async run(
    _event: WorkflowEvent<ConnectionSyncParams>,
    _step: WorkflowStep,
  ): Promise<void> {
    throw new NotImplementedError('ConnectionSync is not implemented yet.');
  }
}
