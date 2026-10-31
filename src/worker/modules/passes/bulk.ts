import { AppError, NotFoundError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { dispatchSafely } from '../delivery/service.ts';
import { setWorkflowRun } from '../templates/repo.ts';
import { isNotFound, resolveTemplate } from './builder.ts';
import { depsOf } from './deps.ts';
import { publishPass } from './publish.ts';
import { insertWorkflowRun, passesForReissue } from './repo.ts';
import type { Actor } from './service.ts';

export const REISSUE_PAGE = 100;

export interface ReissueParams {
  templateId: string | null;
  version: string | null;
  orgId: string | null;
  identityId?: string | null;
  cause: 'template_upgrade' | 'resign';
}

export interface ReissuePageResult {
  nextCursor: string | null;
  changed: number;
  unchanged: number;
  failed: number;
}

/**
 * Rebuilds one page of passes. A pass that fails validation under the new version is counted and
 * skipped; the others still move. Pushes are dispatched once per page.
 */
export async function reissuePage(
  ctx: ServiceContext,
  params: ReissueParams,
  cursor: string | null,
): Promise<ReissuePageResult> {
  const rows = await passesForReissue(ctx.env.DB, {
    templateId: params.templateId,
    orgId: params.orgId,
    identityId: params.identityId ?? null,
    afterId: cursor,
    limit: REISSUE_PAGE,
    skipVersion: params.cause === 'template_upgrade' ? params.version : null,
  });
  const result: ReissuePageResult = { nextCursor: null, changed: 0, unchanged: 0, failed: 0 };
  for (const row of rows) {
    try {
      const published = await publishPass(ctx, {
        passId: row.id,
        cause: params.cause,
        actor: { type: 'system', id: null },
        force: params.cause === 'resign',
        dispatch: false,
        // A re-sign keeps each pass on its current template version.
        mutate: () =>
          params.cause === 'resign' || !params.version ? {} : { templateVersion: params.version },
      });
      if (published.changed) result.changed++;
      else result.unchanged++;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      result.failed++;
      ctx.log.warn('bulk_reissue.pass_failed', {
        passId: row.id,
        templateId: params.templateId,
        code: error.code,
      });
    }
  }
  if (rows.length === REISSUE_PAGE) result.nextCursor = rows[rows.length - 1]?.id ?? null;
  if (result.changed > 0) await dispatchSafely(ctx);
  return result;
}

async function resolveUnscoped(ctx: ServiceContext, id: string, version?: string) {
  try {
    return await depsOf(ctx.env).registry.resolve(id, version);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    ctx.log.warn('bulk_reissue.template_unresolved', { templateId: id, error });
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  }
}

export async function startBulkReissue(
  ctx: ServiceContext,
  actor: Actor,
  body: {
    templateId?: string | undefined;
    version?: string | undefined;
    orgId?: string | undefined;
    cause?: ReissueParams['cause'] | undefined;
    identityId?: string | undefined;
  },
): Promise<string> {
  const template = body.templateId
    ? body.orgId
      ? await resolveTemplate(ctx, body.orgId, body.templateId, body.version)
      : await resolveUnscoped(ctx, body.templateId, body.version)
    : null;
  const targetId = template?.id ?? body.identityId ?? '';
  const instanceId = `bulk-${ctx.ids.id()}`;
  await insertWorkflowRun(ctx.env.DB, {
    instanceId,
    kind: 'bulk_reissue',
    orgId: body.orgId ?? null,
    targetId,
    now: ctx.clock.now(),
  });
  const params: ReissueParams = {
    templateId: template?.id ?? null,
    version: template?.version ?? null,
    orgId: body.orgId ?? null,
    identityId: body.identityId ?? null,
    cause: body.cause ?? 'template_upgrade',
  };
  try {
    await ctx.env.BULK_REISSUE.create({ id: instanceId, params });
  } catch (error) {
    ctx.log.error('passes.workflow_start_failed', {
      orgId: body.orgId ?? null,
      error: error instanceof Error ? error.name : 'unknown',
    });
    await setWorkflowRun(ctx.env.DB, instanceId, 'errored', ctx.clock.now(), {
      errorCode: 'WORKFLOW_START',
    });
    throw new UnavailableError('The rebuild did not start. Try again.', 'WORKFLOW_START');
  }
  await recordAudit(ctx, {
    orgId: body.orgId ?? null,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.bulk_reissue',
    targetType: template ? 'template' : 'identity',
    targetId,
    detail: {
      version: template?.version ?? null,
      instanceId,
      cause: params.cause,
      identityId: body.identityId ?? null,
    },
  });
  return instanceId;
}
