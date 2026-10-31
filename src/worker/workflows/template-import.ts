import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  analyzeStage,
  cleanupStage,
  dryRunStage,
  extractStage,
  failImport,
  type ImportParams,
  persistStage,
  startImport,
} from '../modules/templates/import-pipeline.ts';
import type { AppEnv } from '../platform/env.ts';
import { createServiceContext } from '../platform/service-context.ts';

export type TemplateImportParams = ImportParams;

const RETRY = { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' } } as const;

/** Unzip with limits, validate, derive images, dry-run build, persist version. */
export class TemplateImport extends WorkflowEntrypoint<AppEnv, TemplateImportParams> {
  override async run(
    event: WorkflowEvent<TemplateImportParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const p = event.payload;
    const ctx = createServiceContext(this.env, {
      ctx: this.ctx,
      base: { workflow: 'template-import' },
    });
    try {
      await step.do('start', () => startImport(ctx, p));
      const stages = [
        ['extract', extractStage],
        ['analyze', (c: typeof ctx, x: typeof p) => analyzeStage(c, x)],
        ['dry-run', dryRunStage],
      ] as const;
      for (const [name, fn] of stages) {
        const result = await step.do(name, RETRY, () => fn(ctx, p));
        if (!result.ok) {
          await step.do('cleanup', () => cleanupStage(ctx, p));
          return;
        }
      }
      await step.do(
        'persist',
        RETRY,
        async () => (await persistStage(ctx, p)) ?? { rejected: true },
      );
      await step.do('cleanup', () => cleanupStage(ctx, p));
    } catch (error) {
      ctx.log.error('templates.import_failed', {
        orgId: p.orgId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      await failImport(
        ctx,
        p,
        [{ severity: 'error', code: 'IMPORT_FAILED', message: 'The import failed. Try again.' }],
        'IMPORT_FAILED',
      );
      try {
        await step.do('cleanup-failed', () => cleanupStage(ctx, p));
      } catch (cleanupError) {
        ctx.log.error('templates.cleanup_failed', {
          orgId: p.orgId,
          error: cleanupError instanceof Error ? cleanupError.name : 'unknown',
        });
      }
      throw error;
    }
  }
}
