import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  buildArchive,
  dropParts,
  EXPORT_KEEP_MS,
  entities,
  exportKey,
  writeParts,
} from '../modules/org-lifecycle/export.ts';
import { claimExport, failExport, finishExport } from '../modules/org-lifecycle/repo.ts';
import type { Clock } from '../platform/clock.ts';
import type { AppEnv } from '../platform/env.ts';
import { createJobContext } from '../platform/service-context.ts';

export interface OrgExportParams {
  orgId: string;
  exportId: string;
}

const RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } } as const;
/** Parts per entity one instance writes: 100 steps of 10 pages of 2000 rows. */
const MAX_STEPS_PER_ENTITY = 100;

type StepLike = Pick<WorkflowStep, 'do'>;

/**
 * A complete org archive in R2: NDJSON per entity, zipped. Each page is its own step, so a restart resumes;
 * every step writes the same objects again. Owner: org-lifecycle module.
 */
export async function runOrgExport(
  env: AppEnv,
  params: OrgExportParams,
  step: StepLike,
  exec?: ExecutionContext,
  clock?: Clock,
): Promise<{ state: 'ready' | 'skipped' | 'failed' }> {
  const { orgId, exportId } = params;
  const ctx = createJobContext(env, 'org-export', {
    ...(clock ? { clock } : {}),
    ...(exec ? { ctx: exec } : {}),
    base: { workflow: 'org-export', orgId, exportId },
  });
  if (!(await step.do('claim', () => claimExport(env.DB, exportId)))) return { state: 'skipped' };
  try {
    for (const entity of entities()) {
      let after = 0;
      let part = 0;
      for (let i = 0; i < MAX_STEPS_PER_ENTITY; i++) {
        const [from, at] = [after, part];
        const r = await step.do(`${entity.name}-${i}`, RETRY, () =>
          writeParts(ctx, orgId, exportId, entity, at, from),
        );
        if (r.last === null) break;
        [after, part] = [r.last, r.next];
      }
    }
    const built = await step.do('zip', RETRY, () => buildArchive(ctx, orgId, exportId));
    await step.do('finish', async () => {
      const now = ctx.clock.now();
      await finishExport(env.DB, exportId, {
        r2Key: exportKey(orgId, exportId),
        bytes: built.bytes,
        entities: JSON.stringify(built.entities),
        now,
        expiresAt: now + EXPORT_KEEP_MS,
      });
      await dropParts(ctx, orgId, exportId);
    });
    return { state: 'ready' };
  } catch (error) {
    ctx.log.error('org.export_failed', { orgId, exportId, code: 'ORG_EXPORT_FAILED', error });
    await step.do('fail', () => failExport(env.DB, exportId, 'ORG_EXPORT_FAILED', ctx.clock.now()));
    return { state: 'failed' };
  }
}

export class OrgExport extends WorkflowEntrypoint<AppEnv, OrgExportParams> {
  override async run(event: WorkflowEvent<OrgExportParams>, step: WorkflowStep): Promise<void> {
    await runOrgExport(this.env, event.payload, step, this.ctx);
  }
}
