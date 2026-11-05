import type {
  BroadcastDto,
  BroadcastPreviewDto,
  BroadcastTarget,
  CreateBroadcastBody,
} from '../../../shared/contracts/broadcasts.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { BUDGET_WINDOW_MS } from '../passes/change-messages.ts';
import type { Actor } from '../passes/service.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { targetFilter } from './apply.ts';
import { toDto } from './dto.ts';
import {
  assertCanChange,
  type BroadcastScope,
  checkTemplates,
  checkTime,
  nameOf,
  requireBroadcast,
} from './guards.ts';
import * as repo from './repo.ts';
import { countTarget } from './repo-target.ts';
import { launchBroadcast } from './start.ts';

export async function createBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  mode: Mode,
  body: CreateBroadcastBody,
): Promise<BroadcastDto> {
  return insertBroadcast(ctx, actor, mode, body, 'broadcast.create');
}

export async function insertBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  mode: Mode,
  body: CreateBroadcastBody,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<BroadcastDto> {
  if (!(await orgIsActive(ctx.env.DB, body.orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  if (body.at !== undefined) checkTime(ctx, body.at);
  await checkTemplates(ctx, body);
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  const at = body.send === 'schedule' ? (body.at ?? now) : now;
  await repo
    .insertBroadcastStmt(ctx.env.DB, {
      id,
      orgId: body.orgId,
      mode,
      kind: body.kind,
      name: nameOf(body),
      state: body.send === 'draft' ? 'draft' : 'scheduled',
      target: body.target,
      patch: body.patch,
      notify: body.notify,
      at: body.send === 'draft' ? null : at,
      clearAfter: body.clearAfter ?? null,
      actor: { type: actor.type, id: actor.id },
      now,
    })
    .run();
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

/** Sends a draft now, or at `at`. */
export async function sendBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  at: number | undefined,
  scope: BroadcastScope,
): Promise<BroadcastDto> {
  const row = await requireBroadcast(ctx, id, scope.orgScope, scope.mode);
  assertCanChange(scope, row.kind);
  if (at !== undefined) checkTime(ctx, at);
  if (!(await repo.casSchedule(ctx.env.DB, id, at ?? ctx.clock.now())))
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
  return getBroadcastDto(ctx, id, scope.orgScope);
}

export async function cancelBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  scope: BroadcastScope,
): Promise<BroadcastDto> {
  const row = await requireBroadcast(ctx, id, scope.orgScope, scope.mode);
  const won = await repo.casState(ctx.env.DB, id, ['draft', 'scheduled'], 'cancelled', {
    finishedAt: ctx.clock.now(),
  });
  if (!won)
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
  return getBroadcastDto(ctx, id, scope.orgScope);
}

export async function getBroadcastDto(
  ctx: ServiceContext,
  id: string,
  orgScope: string | null,
): Promise<BroadcastDto> {
  const row = await requireBroadcast(ctx, id, orgScope);
  return toDto(
    row,
    await repo.countItems(ctx.env.DB, [id]),
    await repo.followUpsOf(ctx.env.DB, [id]),
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
  );
  const followUps = await repo.followUpsOf(
    ctx.env.DB,
    rows.map((r) => r.id),
  );
  return { items: rows.map((r) => toDto(r, counts, followUps)), nextCursor };
}

/** The live count behind the composer: matches, on-device and already at the daily limit. */
export async function previewTarget(
  ctx: ServiceContext,
  mode: Mode,
  orgId: string,
  target: BroadcastTarget,
): Promise<BroadcastPreviewDto> {
  const limit = (await getPlatformSettings(ctx))['push.budgetPerDay'];
  const filter = targetFilter({ org_id: orgId, mode, target: JSON.stringify(target) }, null, 1);
  const counts = await countTarget(
    ctx.env.DB,
    filter,
    ctx.clock.now(),
    ctx.clock.now() - BUDGET_WINDOW_MS,
    limit,
  );
  return { ...counts, limit };
}
