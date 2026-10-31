import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { AppEnv } from '../platform/env.ts';
import { NotImplementedError } from '../platform/errors.ts';

export interface TemplateImportParams {
  uploadId: string;
  orgId: string;
  /** R2 key of the uploaded archive (uploads/...). */
  objectKey: string;
  createdBy: string | null;
}

/** Unzip with limits, validate, derive images, dry-run build, persist version. Owner: templates module. */
export class TemplateImport extends WorkflowEntrypoint<AppEnv, TemplateImportParams> {
  override async run(
    _event: WorkflowEvent<TemplateImportParams>,
    _step: WorkflowStep,
  ): Promise<void> {
    throw new NotImplementedError('TemplateImport is not implemented yet.');
  }
}
