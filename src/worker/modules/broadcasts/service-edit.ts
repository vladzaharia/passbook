import type {
  BroadcastDto,
  BroadcastItemDto,
  BroadcastOutcome,
  CreateBroadcastBody,
} from '../../../shared/contracts/broadcasts.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { ScopeArg } from '../passes/scope.ts';
import type { Actor } from '../passes/service.ts';
import {
  assertCanChange,
  type BroadcastScope,
  checkTemplates,
  checkTime,
  nameOf,
  plainLine,
  requireBroadcast,
  requireWritableBroadcast,
} from './guards.ts';
import * as repo from './repo.ts';
import { listItems } from './repo-items.ts';
import { getBroadcastDto, insertBroadcast } from './service.ts';
import { launchBroadcast } from './start.ts';

/** Saves new values over a draft or a scheduled message that has not started. */
export async function updateBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  body: CreateBroadcastBody,
  scope: BroadcastScope,
): Promise<BroadcastDto> {
  const row = await requireWritableBroadcast(ctx, id, scope);
  assertCanChange(scope, row.kind);
  assertCanChange(scope, body.kind);
  if (body.orgId !== row.org_id)
    throw new ValidationError(
      'A message cannot move to another organization.',
      [],
      'BROADCAST_ORG',
    );
  if (row.state !== 'draft' && row.state !== 'scheduled')
    throw new ConflictError(
      'Only a draft or scheduled message can be edited.',
      'BROADCAST_NOT_EDITABLE',
    );
  if (body.at !== undefined) checkTime(ctx, body.at);
  await checkTemplates(ctx, body);
  const now = ctx.clock.now();
  const won = await repo.updateBroadcast(ctx.env.DB, id, {
    name: nameOf(body),
    kind: body.kind,
    target: body.target,
    patch: body.patch,
    notify: body.notify,
    state: body.send === 'draft' ? 'draft' : 'scheduled',
    at: body.send === 'draft' ? null : body.send === 'schedule' ? (body.at ?? now) : now,
    clearAfter: body.clearAfter ?? null,
  });
  if (!won)
    throw new ConflictError(
      'This message already started. Open it again.',
      'BROADCAST_NOT_EDITABLE',
    );
  await recordAudit(ctx, {
    orgId: row.org_id,
    actorType: actor.type,
    actorId: actor.id,
    action: 'broadcast.update',
    targetType: 'broadcast',
    targetId: id,
    detail: { kind: body.kind, send: body.send },
  });
  if (body.send === 'now') await launchBroadcast(ctx, row);
  return getBroadcastDto(ctx, id, scope);
}

/** Copies a failed, partial or cancelled broadcast as a new one and sends it now, in its own mode. */
export async function retryBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  scope: BroadcastScope,
): Promise<BroadcastDto> {
  const row = await requireWritableBroadcast(ctx, id, scope);
  assertCanChange(scope, row.kind);
  if (!['failed', 'partial', 'cancelled'].includes(row.state))
    throw new ConflictError(
      'Only a failed or cancelled message can be sent again.',
      'BROADCAST_NOT_RETRYABLE',
    );
  return insertBroadcast(
    ctx,
    actor,
    row.mode,
    {
      orgId: row.org_id,
      kind: row.kind,
      name: plainLine(row.name).slice(0, 80) || 'Message',
      target: JSON.parse(row.target),
      patch: JSON.parse(row.patch),
      notify: row.notify === 1,
      send: 'now',
      clearAfter: row.clear_after,
    },
    'broadcast.retry',
    { retryOf: id },
  );
}

/** Per-pass outcomes of a broadcast, by pass id. */
export async function listBroadcastItems(
  ctx: ServiceContext,
  id: string,
  scope: ScopeArg,
  query: { outcome?: BroadcastOutcome | undefined; cursor?: string | undefined; limit: number },
): Promise<{ items: BroadcastItemDto[]; nextCursor: string | null }> {
  await requireBroadcast(ctx, id, scope);
  const { rows, nextCursor } = await listItems(ctx.env.DB, id, query);
  return {
    items: rows.map((r) => ({
      passId: r.pass_id,
      title: r.title,
      holderEmail: r.holder_email,
      outcome: r.outcome,
      silent: r.silent === 1,
    })),
    nextCursor,
  };
}
