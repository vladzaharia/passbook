import type { BroadcastDto } from '../../../shared/contracts/broadcasts.ts';
import type { CreateBroadcastBody } from '../../../shared/contracts/broadcasts-change.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { changeRunDrifted } from '../../../shared/contracts/pass-selection.ts';
import { batch } from '../../platform/db.ts';
import { entitlementsOf } from '../../platform/entitlements.ts';
import {
  ConflictError,
  FeatureLimitError,
  ForbiddenError,
  NotFoundError,
  SandboxQuotaError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { isPreviewOnlyOrg } from '../developer/fence.ts';
import { orgIsActive } from '../orgs/repo.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import type { ScopeArg } from '../passes/scope.ts';
import type { Actor } from '../passes/service.ts';
import { prepareTarget, storedTargetOf } from './change-target.ts';
import { toDto } from './dto.ts';
import {
  assertCanChange,
  type BroadcastScope,
  checkTemplates,
  checkTime,
  nameOf,
  requireBroadcast,
  requireWritableBroadcast,
} from './guards.ts';
import * as repo from './repo.ts';
import { DAY_LIMIT_KEY, manualBroadcastsToday } from './repo-day-limit.ts';
import {
  chosenTargetsStmts,
  resumableCount,
  resumedBy,
  resumeTargetsStmt,
} from './repo-selection.ts';
import { launchBroadcast } from './start.ts';
import type { StoredBroadcastTarget } from './stored-target.ts';

export async function createBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  mode: Mode,
  body: CreateBroadcastBody,
  authority: TenantPassWrite,
  hooks: { onInserted?: () => void; limit?: () => Promise<void> } = {},
): Promise<BroadcastDto> {
  return insertBroadcast(ctx, actor, mode, body, authority, 'broadcast.create', hooks);
}

export async function insertBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  mode: Mode,
  input: CreateBroadcastBody,
  authority: TenantPassWrite,
  action: string,
  options: {
    detail?: Record<string, unknown>;
    onInserted?: () => void;
    /** Runs after the body is validated and before anything is written (the rate limit). */
    limit?: () => Promise<void>;
    /** A retry of a change run: it takes the passes of this run that were never changed. */
    resume?: { parentId: string };
    /** What only the server sets on a target, kept when a run is sent again. */
    keep?: Pick<StoredBroadcastTarget, 'window' | 'sentBy'>;
  } = {},
): Promise<BroadcastDto> {
  const { detail = {}, onInserted, keep, limit, resume } = options;
  if (!(await orgIsActive(ctx.env.DB, input.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  if (input.at !== undefined) checkTime(ctx, input.at);
  const { expectCount: seen, ...bare } = input.target;
  const body = await prepareTarget(ctx, mode, resume ? { ...input, target: bare } : input);
  await checkTemplates(ctx, body, mode);
  if (resume) {
    // A resumed run takes what its parent left: the count the admin saw is that remainder.
    const left = (await resumableCount(ctx.env.DB, resume.parentId, body.orgId, mode)).left;
    if (seen !== undefined && changeRunDrifted(seen, left))
      throw new ConflictError(
        `${left} passes are left, not ${seen}. Review it again.`,
        'SELECTION_CHANGED',
      );
  }
  await limit?.();
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  const token = ctx.ids.id();
  const change = body.kind === 'change';
  const selection = !change
    ? undefined
    : resume
      ? ('resume' as const)
      : body.target.passIds
        ? ('ids' as const)
        : ('live' as const);
  const at = body.send === 'schedule' ? (body.at ?? now) : now;
  const [inserted] = await batch(ctx.env.DB, [
    repo.insertAuthorizedBroadcastStmt(
      ctx.env.DB,
      {
        id,
        orgId: body.orgId,
        mode,
        kind: body.kind,
        name: nameOf(body),
        state: body.send === 'draft' ? 'draft' : 'scheduled',
        target: {
          ...storedTargetOf(body, {
            ...(selection ? { selection, token } : {}),
            ...(resume ? { retryOf: resume.parentId } : {}),
            ...(resume && seen !== undefined ? { expectCount: seen } : {}),
          }),
          ...keep,
        },
        patch: body.patch,
        notify: body.notify ?? body.kind === 'message',
        at: body.send === 'draft' ? null : at,
        clearAfter: body.clearAfter ?? null,
        ...(resume ? { retryOf: resume.parentId } : {}),
        actor: { type: actor.type, id: actor.id },
        now,
      },
      authority,
      now,
    ),
    ...(selection === 'ids' && body.target.passIds
      ? chosenTargetsStmts(ctx.env.DB, {
          id,
          orgId: body.orgId,
          mode,
          token,
          ids: body.target.passIds,
          replace: false,
        })
      : []),
    ...(resume
      ? [
          resumeTargetsStmt(ctx.env.DB, {
            id,
            parentId: resume.parentId,
            orgId: body.orgId,
            mode,
            token,
          }),
        ]
      : []),
  ]);
  if ((inserted?.meta.changes ?? 0) !== 1) {
    // The unique index on retry_of: another resume of this run won.
    if (resume && (await resumedBy(ctx.env.DB, resume.parentId)))
      throw new ConflictError('This change was already resumed.', 'BROADCAST_NOT_RETRYABLE');
    throw await insertRefusal(ctx, body.orgId, mode, now, body.kind);
  }
  onInserted?.();
  await recordAudit(ctx, {
    orgId: body.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action,
    targetType: 'broadcast',
    targetId: id,
    detail: { kind: body.kind, send: body.send, mode, ...detail },
  });
  if (body.send === 'now') await launchBroadcast(ctx, { id, org_id: body.orgId });
  return getBroadcastDto(ctx, id, body.orgId);
}

/** A refused insert is the plan's daily cap when the org has used it, otherwise the lost authority. */
async function insertRefusal(
  ctx: ServiceContext,
  orgId: string,
  mode: Mode,
  now: number,
  kind: CreateBroadcastBody['kind'],
): Promise<Error> {
  const key = DAY_LIMIT_KEY[kind];
  const limit = (await entitlementsOf(ctx, orgId))[key];
  const used = await manualBroadcastsToday(ctx.env.DB, orgId, mode, now, kind);
  return typeof limit === 'number' && used >= limit
    ? (await isPreviewOnlyOrg(ctx.env.DB, orgId))
      ? new SandboxQuotaError({ key, limit, used })
      : new FeatureLimitError({ key, limit, used })
    : new ForbiddenError();
}

/** Sends a draft now, or at `at`. */
export async function sendBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  at: number | undefined,
  scope: BroadcastScope,
): Promise<BroadcastDto> {
  const row = await requireWritableBroadcast(ctx, id, scope);
  assertCanChange(scope, row.kind);
  if (at !== undefined) checkTime(ctx, at);
  const now = ctx.clock.now();
  const [scheduled] = await batch(ctx.env.DB, [
    repo.scheduleBroadcastStmt(ctx.env.DB, id, row.kind, at ?? now, scope.authority, now),
  ]);
  if ((scheduled?.meta.changes ?? 0) !== 1)
    throw new ConflictError('Only a draft can be sent.', 'BROADCAST_NOT_DRAFT');
  await recordAudit(ctx, {
    orgId: row.org_id,
    actorType: actor.type,
    actorId: actor.id,
    action: 'broadcast.send',
    targetType: 'broadcast',
    targetId: id,
    detail: { scheduled: at !== undefined },
  });
  if (at === undefined) await launchBroadcast(ctx, row);
  return getBroadcastDto(ctx, id, scope);
}

export async function cancelBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  scope: BroadcastScope,
): Promise<BroadcastDto> {
  const row = await requireWritableBroadcast(ctx, id, scope);
  const now = ctx.clock.now();
  const [cancelled] = await batch(ctx.env.DB, [
    repo.cancelBroadcastStmt(ctx.env.DB, id, scope.authority, now),
  ]);
  if ((cancelled?.meta.changes ?? 0) !== 1)
    throw new ConflictError(
      'Only a draft or scheduled message can be cancelled.',
      'BROADCAST_NOT_CANCELLABLE',
    );
  await recordAudit(ctx, {
    orgId: row.org_id,
    actorType: actor.type,
    actorId: actor.id,
    action: 'broadcast.cancel',
    targetType: 'broadcast',
    targetId: id,
  });
  return getBroadcastDto(ctx, id, scope);
}

export async function getBroadcastDto(
  ctx: ServiceContext,
  id: string,
  scope: ScopeArg,
): Promise<BroadcastDto> {
  const row = await requireBroadcast(ctx, id, scope);
  return toDto(
    row,
    await repo.countItems(ctx.env.DB, [id], row.org_id, row.mode),
    await repo.followUpsOf(ctx.env.DB, [id], row.org_id, row.mode),
  );
}

export async function listBroadcastDtos(
  ctx: ServiceContext,
  filter: repo.BroadcastListFilter,
): Promise<{ items: BroadcastDto[]; nextCursor: string | null }> {
  const { rows, nextCursor } = await repo.listBroadcasts(ctx.env.DB, filter);
  const counts = await repo.countItems(
    ctx.env.DB,
    rows.map((r) => r.id),
    filter.orgId,
    filter.mode,
  );
  const followUps = await repo.followUpsOf(
    ctx.env.DB,
    rows.map((r) => r.id),
    filter.orgId,
    filter.mode,
  );
  return { items: rows.map((r) => toDto(r, counts, followUps)), nextCursor };
}
