import { AppError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { dispatchSafely } from '../delivery/service.ts';
import { resolveTemplate } from './builder.ts';
import { depsOf } from './deps.ts';
import { publishPass } from './publish.ts';
import { insertWorkflowRun, passesForReissue } from './repo.ts';
import type { Actor } from './service.ts';

export const REISSUE_PAGE = 100;

export interface ReissueParams {
  templateId: string;
  version: string;
  orgId: string | null;
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
        mutate: () => ({ templateVersion: params.version }),
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
    ctx.log.warn('bulk_reissue.template_unresolved', { templateId: id, error });
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  }
}

export async function startBulkReissue(
  ctx: ServiceContext,
  actor: Actor,
  body: { templateId: string; version?: string | undefined; orgId?: string | undefined },
): Promise<string> {
  const template = body.orgId
    ? await resolveTemplate(ctx, body.orgId, body.templateId, body.version)
    : await resolveUnscoped(ctx, body.templateId, body.version);
  const instanceId = `bulk-${ctx.ids.id()}`;
  await insertWorkflowRun(ctx.env.DB, {
    instanceId,
    kind: 'bulk_reissue',
    orgId: body.orgId ?? null,
    targetId: template.id,
    now: ctx.clock.now(),
  });
  const params: ReissueParams = {
    templateId: template.id,
    version: template.version,
    orgId: body.orgId ?? null,
    cause: 'template_upgrade',
  };
  await ctx.env.BULK_REISSUE.create({ id: instanceId, params });
  await recordAudit(ctx, {
    orgId: body.orgId ?? null,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.bulk_reissue',
    targetType: 'template',
    targetId: template.id,
    detail: { version: template.version, instanceId },
  });
  return instanceId;
}
