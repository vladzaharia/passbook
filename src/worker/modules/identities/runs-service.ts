import type { IdentityRunDto } from '../../../shared/contracts/identities.ts';
import type { Actor } from '../../platform/context.ts';
import { requireEntitled } from '../../platform/entitlements.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditActor, recordAudit } from '../audit/service.ts';
import { getOrgRow } from '../orgs/repo.ts';
import { RESERVED_HANDLES } from './handles.ts';
import type { PlatformSlot } from './provision-platform.ts';
import { managedIdentityOf } from './repo-provision.ts';
import { cancelRunRow, getRun, pageRuns, type RunRow } from './repo-runs.ts';
import {
  type StartedRun,
  startPlatformProvision,
  startProvision,
  startRotation,
} from './run-start.ts';

export function toRunDto(r: RunRow): IdentityRunDto {
  return {
    id: r.id,
    orgId: r.org_id,
    kind: r.kind,
    targetType: r.target_type,
    targetId: r.target_id,
    state: r.state,
    step: r.step,
    attempt: r.attempt,
    waitingFor: r.waiting_for,
    errorCode: r.error_code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
}

export async function requireRun(ctx: ServiceContext, id: string): Promise<RunRow> {
  const row = await getRun(ctx.env.DB, id);
  if (!row) throw new NotFoundError('Run not found.', 'IDENTITY_RUN_NOT_FOUND');
  return row;
}

export async function listRuns(
  ctx: ServiceContext,
  query: {
    cursor?: string | undefined;
    limit: number;
    orgId?: string | undefined;
    targetId?: string | undefined;
  },
) {
  const rows = await pageRuns(ctx.env.DB, {
    ...query,
    after: query.cursor,
    limit: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  return {
    items: page.map(toRunDto),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** What provisioning needs, for a first start and a retry alike: an active org, the feature, no identity yet. */
async function assertCanProvision(ctx: ServiceContext, orgId: string): Promise<void> {
  const org = await getOrgRow(ctx.env.DB, orgId);
  if (org?.status !== 'active') throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  await requireEntitled(ctx, orgId, 'identity.managed');
  if ((await managedIdentityOf(ctx.env.DB, orgId))?.cert_pem)
    throw new ConflictError(
      'This organization already has a managed identity.',
      'IDENTITY_ALREADY_PROVISIONED',
    );
}

/** Starts the managed identity of an org, or returns the run already open for it. */
export async function startManagedIdentity(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  handle: string | undefined,
): Promise<IdentityRunDto> {
  await assertCanProvision(ctx, orgId);
  if (handle && RESERVED_HANDLES.has(handle))
    throw new ValidationError(
      'This handle is reserved. Choose another.',
      [],
      'IDENTITY_HANDLE_RESERVED',
    );
  const started = await startProvision(ctx, {
    orgId,
    ...(handle ? { handle } : {}),
    createdBy: actor.type === 'user' ? actor.id : null,
  });
  return toRunDto(await requireRun(ctx, started.runId));
}

/** Starts the setup run of a platform slot; an open run for the slot is returned as is. */
export async function startPlatformIdentity(
  ctx: ServiceContext,
  actor: Actor,
  slot: PlatformSlot,
): Promise<IdentityRunDto> {
  const started = await startPlatformProvision(ctx, {
    slot,
    createdBy: actor.type === 'user' ? actor.id : null,
  });
  return toRunDto(await requireRun(ctx, started.runId));
}

/** A new certificate now, for a managed identity; returns the open run when one exists. */
export async function renewIdentity(
  ctx: ServiceContext,
  actor: Actor,
  identityId: string,
): Promise<IdentityRunDto> {
  const started = await startRotation(ctx, {
    identityId,
    createdBy: actor.type === 'user' ? actor.id : null,
  });
  const run = await requireRun(ctx, started.runId);
  if (started.created)
    await recordAudit(ctx, {
      ...auditActor(actor),
      orgId: run.org_id,
      action: 'identity.renew_requested',
      targetType: 'identity',
      targetId: identityId,
      detail: { runId: run.id },
    });
  return toRunDto(run);
}

export async function retryRun(
  ctx: ServiceContext,
  actor: Actor,
  run: RunRow,
): Promise<IdentityRunDto> {
  if (run.state !== 'failed' && run.state !== 'cancelled')
    throw new ConflictError('Only a failed or cancelled run can be retried.', 'IDENTITY_RUN_OPEN');
  const createdBy = actor.type === 'user' ? actor.id : null;
  let started: StartedRun;
  if (run.kind === 'provision') {
    await assertCanProvision(ctx, run.target_id);
    const ref = run.external_ref
      ? (JSON.parse(run.external_ref) as { requestedHandle?: string })
      : {};
    started = await startProvision(ctx, {
      orgId: run.target_id,
      ...(ref.requestedHandle ? { handle: ref.requestedHandle } : {}),
      createdBy,
    });
  } else started = await startRotation(ctx, { identityId: run.target_id, createdBy });
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: run.org_id,
    action: 'identity.run_retry',
    targetType: run.target_type,
    targetId: run.target_id,
    detail: { runId: run.id, newRunId: started.runId },
  });
  return toRunDto(await requireRun(ctx, started.runId));
}

export async function cancelRun(
  ctx: ServiceContext,
  actor: Actor,
  run: RunRow,
): Promise<IdentityRunDto> {
  if (!(await cancelRunRow(ctx.env.DB, run.id, ctx.clock.now())))
    throw new ConflictError('This run has already finished.', 'IDENTITY_RUN_CLOSED');
  await recordAudit(ctx, {
    ...auditActor(actor),
    orgId: run.org_id,
    action: 'identity.run_cancel',
    targetType: run.target_type,
    targetId: run.target_id,
    detail: { runId: run.id, step: run.step },
  });
  return toRunDto(await requireRun(ctx, run.id));
}
