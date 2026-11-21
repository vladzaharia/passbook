import type {
  BroadcastDto,
  BroadcastItemDto,
  BroadcastOutcome,
} from '../../../shared/contracts/broadcasts.ts';
import type { CreateBroadcastBody } from '../../../shared/contracts/broadcasts-change.ts';
import { batch } from '../../platform/db.ts';
import { ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { ScopeArg } from '../passes/scope.ts';
import type { Actor } from '../passes/service.ts';
import { prepareTarget, storedTargetOf } from './change-target.ts';
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
import { childOf } from './repo-undo.ts';
import { getBroadcastDto, insertBroadcast } from './service.ts';
import { launchBroadcast } from './start.ts';
import type { StoredBroadcastTarget } from './stored-target.ts';

/** Saves new values over a draft or a scheduled message that has not started. */
export async function updateBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  input: CreateBroadcastBody,
  scope: BroadcastScope,
): Promise<BroadcastDto> {
  const row = await requireWritableBroadcast(ctx, id, scope);
  assertCanChange(scope, row.kind);
  assertCanChange(scope, input.kind);
  if (input.orgId !== row.org_id)
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
  if (input.at !== undefined) checkTime(ctx, input.at);
  const body = await prepareTarget(ctx, row.mode, input);
  await checkTemplates(ctx, body);
  const now = ctx.clock.now();
  const [edited] = await batch(ctx.env.DB, [
    repo.updateBroadcastStmt(
      ctx.env.DB,
      id,
      row.kind,
      {
        name: nameOf(body),
        kind: body.kind,
        target: storedTargetOf(body),
        patch: body.patch,
        notify: body.notify,
        state: body.send === 'draft' ? 'draft' : 'scheduled',
        at: body.send === 'draft' ? null : body.send === 'schedule' ? (body.at ?? now) : now,
        clearAfter: body.clearAfter ?? null,
      },
      scope.authority,
      now,
    ),
  ]);
  if ((edited?.meta.changes ?? 0) !== 1)
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
  const stored = JSON.parse(row.target) as StoredBroadcastTarget;
  // An undo is asked for again with /undo; a run that was undone is not run again over its undo.
  if (stored.revertOf || (await childOf(ctx.env.DB, id, row.org_id, row.mode)))
    throw new ConflictError('This change was undone.', 'BROADCAST_NOT_RETRYABLE');
  const { window, sentBy, message, expectCount: _seen, ...target } = stored;
  return insertBroadcast(
    ctx,
    actor,
    row.mode,
    {
      orgId: row.org_id,
      kind: row.kind,
      name: plainLine(row.name).slice(0, 80) || 'Message',
      target: target as CreateBroadcastBody['target'],
      patch: JSON.parse(row.patch),
      notify: row.notify === 1,
      send: 'now',
      clearAfter: row.clear_after,
      ...(message ? { message } : {}),
    },
    scope.authority,
    'broadcast.retry',
    {
      detail: { retryOf: id },
      keep: { ...(window ? { window } : {}), ...(sentBy ? { sentBy } : {}) },
    },
  );
}

/** Per-pass outcomes of a broadcast, by pass id. */
export async function listBroadcastItems(
  ctx: ServiceContext,
  id: string,
  scope: ScopeArg,
  query: { outcome?: BroadcastOutcome | undefined; cursor?: string | undefined; limit: number },
): Promise<{ items: BroadcastItemDto[]; nextCursor: string | null }> {
  const row = await requireBroadcast(ctx, id, scope);
  const { rows, nextCursor } = await listItems(ctx.env.DB, id, row.org_id, row.mode, query);
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
