import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { AppEnv } from '../platform/env.ts';
import { NotImplementedError } from '../platform/errors.ts';

export interface BulkReissueParams {
  templateId: string;
  version: string;
  orgId: string | null;
  cause: 'template_upgrade' | 'resign';
}

/** Rebuild passes in chunks of 100 with CAS publish. Owner: passes module. */
export class BulkReissue extends WorkflowEntrypoint<AppEnv, BulkReissueParams> {
  override async run(_event: WorkflowEvent<BulkReissueParams>, _step: WorkflowStep): Promise<void> {
    throw new NotImplementedError('BulkReissue is not implemented yet.');
  }
}
