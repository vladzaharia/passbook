import type { Mode } from '../../../shared/contracts/common.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnavailableError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { getTemplate } from '../templates/repo.ts';
import { isNotFound, resolveTemplate } from './builder.ts';
import type { ReissueParams } from './bulk-reissue-page.ts';
import { depsOf } from './deps.ts';
import type { TenantPassWrite } from './http.ts';
import {
  insertPlatformAdminBulkWorkflowRun,
  insertTenantBulkWorkflowRun,
  insertWorkflowRun,
  setWorkflowStatus,
} from './repo.ts';
import { reserveWorkflowReleases } from './repo-workflow-releases.ts';
import type { Actor } from './service.ts';

async function resolveUnscoped(ctx: ServiceContext, id: string, version: string) {
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
  options?: {
    authority?: TenantPassWrite;
    mode?: Mode;
    platformSession?: Pick<SessionAuth, 'userId' | 'sessionId'>;
    /** Release claimed by a scheduled single-scope upgrade. */
    expectedRelease?: { id: string; generation: number };
  },
): Promise<string> {
  const cause = body.cause ?? 'template_upgrade';
  const orgId = body.orgId ?? null;
  const templateId = body.templateId ?? null;
  let version: string | null = body.version ?? null;
  let release: { id: string; generation: number; version: string } | undefined;
  if (options?.authority && options.platformSession) throw new ForbiddenError();
  if (
    options?.authority &&
    (orgId === null ||
      orgId !== options.authority.orgId ||
      !options.mode ||
      options.authority.mode !== options.mode)
  )
    throw new ForbiddenError();
  if (options?.platformSession && (orgId !== null || !options.mode)) throw new ForbiddenError();
  if (
    options?.expectedRelease &&
    (cause !== 'template_upgrade' || !templateId || !orgId || !options.mode)
  )
    throw new ConflictError('The queued release scope is missing.', 'TEMPLATE_RELEASE_CONFLICT');

  if (templateId) {
    const template = await getTemplate(ctx.env.DB, templateId);
    if (
      !template ||
      template.status === 'deleted' ||
      (orgId !== null && template.orgId !== null && template.orgId !== orgId)
    )
      throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');

    if (cause === 'template_upgrade' && orgId !== null && options?.mode) {
      const approved = await requireApprovedRelease(ctx, templateId, orgId, options.mode, 'apple');
      if (
        (body.version !== undefined && body.version !== approved.version) ||
        (options.expectedRelease &&
          (options.expectedRelease.id !== approved.id ||
            options.expectedRelease.generation !== approved.generation))
      ) {
        throw new ConflictError(
          'The approved release changed. Start the rebuild again.',
          'TEMPLATE_RELEASE_CONFLICT',
        );
      }
      await resolveTemplate(ctx, orgId, templateId, approved.version);
      version = approved.version;
      release = { id: approved.id, generation: approved.generation, version: approved.version };
    } else if (body.version !== undefined) {
      // Explicit versions are checked, but an omitted version never resolves the draft pointer.
      if (orgId !== null) await resolveTemplate(ctx, orgId, templateId, body.version);
      else await resolveUnscoped(ctx, templateId, body.version);
      version = body.version;
    }
  }

  const targetId = templateId ?? body.identityId ?? orgId ?? '';
  const instanceId = `bulk-${ctx.ids.id()}`;
  if (cause === 'template_upgrade') {
    const reserved = await reserveWorkflowReleases(ctx.env.DB, {
      instanceId,
      orgId,
      mode: options?.mode ?? null,
      templateId,
      targetId,
      identityId: body.identityId ?? null,
      // An omitted version captures each scope's own effective release.
      version: body.version ?? null,
      now: ctx.clock.now(),
      ...(release ? { expectedRelease: release } : {}),
      ...(options?.authority ? { authority: options.authority } : {}),
      ...(options?.platformSession ? { platformSession: options.platformSession } : {}),
    });
    if (reserved === 'forbidden') throw new ForbiddenError();
    if (reserved === 'release_changed')
      throw new ConflictError(
        'The approved release changed. Start the rebuild again.',
        'TEMPLATE_RELEASE_CONFLICT',
      );
  } else if (options?.authority) {
    if (orgId === null) throw new ForbiddenError();
    const now = ctx.clock.now();
    const inserted = await insertTenantBulkWorkflowRun(
      ctx.env.DB,
      { instanceId, orgId, targetId, now },
      options.authority,
    );
    if (!inserted) throw new ForbiddenError();
  } else if (options?.platformSession) {
    const now = ctx.clock.now();
    const inserted = await insertPlatformAdminBulkWorkflowRun(
      ctx.env.DB,
      { instanceId, orgId: null, targetId, now },
      options.platformSession,
    );
    if (!inserted) throw new ForbiddenError();
  } else {
    await insertWorkflowRun(ctx.env.DB, {
      instanceId,
      kind: 'bulk_reissue',
      orgId,
      targetId,
      now: ctx.clock.now(),
    });
  }
  const params: ReissueParams = {
    templateId,
    version,
    orgId,
    identityId: body.identityId ?? null,
    ...(options?.mode ? { mode: options.mode } : {}),
    ...(cause === 'template_upgrade' ? { workflowInstanceId: instanceId } : {}),
    ...(release ? { releaseId: release.id, releaseGeneration: release.generation } : {}),
    cause,
  };
  try {
    await ctx.env.BULK_REISSUE.create({ id: instanceId, params });
  } catch (error) {
    ctx.log.error('passes.workflow_start_failed', {
      orgId: body.orgId ?? null,
      code: 'WORKFLOW_START_FAILED',
      error,
    });
    await setWorkflowStatus(ctx.env.DB, instanceId, 'errored', ctx.clock.now(), 'WORKFLOW_START');
    throw new UnavailableError('The rebuild did not start. Try again.', 'WORKFLOW_START');
  }
  await recordAudit(ctx, {
    orgId: body.orgId ?? null,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.bulk_reissue',
    targetType: templateId ? 'template' : params.cause === 'branding' ? 'org' : 'identity',
    targetId,
    detail: {
      version,
      instanceId,
      cause: params.cause,
      identityId: body.identityId ?? null,
    },
  });
  return instanceId;
}
