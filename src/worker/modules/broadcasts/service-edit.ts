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
import { settlePending } from './change-intent.ts';
import { limitChanges } from './change-limit.ts';
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
import { chosenTargetsStmts, resumableCount } from './repo-selection.ts';
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
  await checkTemplates(ctx, body, row.mode);
  const now = ctx.clock.now();
  const token = ctx.ids.id();
  const change = body.kind === 'change';
  const [edited] = await batch(ctx.env.DB, [
    repo.updateBroadcastStmt(
      ctx.env.DB,
      id,
      row.kind,
      {
        name: nameOf(body),
        kind: body.kind,
        target: storedTargetOf(
          body,
          change ? { selection: body.target.passIds ? 'ids' : 'live', token } : {},
        ),
        patch: body.patch,
        notify: body.notify ?? body.kind === 'message',
        state: body.send === 'draft' ? 'draft' : 'scheduled',
        at: body.send === 'draft' ? null : body.send === 'schedule' ? (body.at ?? now) : now,
        clearAfter: body.clearAfter ?? null,
      },
      scope.authority,
      now,
    ),
    // The save's own target rows replace the draft's: guarded by the token only this save wrote.
    ...(change
      ? chosenTargetsStmts(ctx.env.DB, {
          id,
          orgId: row.org_id,
          mode: row.mode,
          token,
          ids: body.target.passIds ?? [],
          replace: true,
        })
      : []),
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
  expectCount?: number,
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
  if (row.kind === 'change') return resumeChange(ctx, actor, row, scope, stored, expectCount);
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

/**
 * A change run is resumed, not copied: the new run takes only the passes the old one never changed
 * (no `updated` or `unchanged` item), so no pass gets an operation twice. It needs the count of passes
 * left (`expectCount`) and goes through the same rate limit as a new run. A run that never took its
 * passes, or ended because its selection moved, is made again from the passes list.
 */
async function resumeChange(
  ctx: ServiceContext,
  actor: Actor,
  row: repo.BroadcastRow,
  scope: BroadcastScope,
  stored: StoredBroadcastTarget,
  expectCount: number | undefined,
): Promise<BroadcastDto> {
  if (row.parent_id !== null || row.error_code === 'SELECTION_CHANGED')
    throw new ConflictError('Make this change again from the passes.', 'BROADCAST_NOT_RETRYABLE');
  if (await repo.resumedBy(ctx.env.DB, row.id))
    throw new ConflictError('This change was already resumed.', 'BROADCAST_NOT_RETRYABLE');
  // A step that died between a pass's write and its item is settled first, so the remainder is exact.
  await settlePending(ctx, row);
  if ((await resumableCount(ctx.env.DB, row.id, row.org_id, row.mode)).all === 0)
    throw new ConflictError(
      'This change never took its passes. Make it again.',
      'BROADCAST_NOT_RETRYABLE',
    );
  if (expectCount === undefined)
    throw new ValidationError(
      'Send expectCount: the passes this change has left.',
      [{ path: 'expectCount', message: 'Required to resume a change.' }],
      'EXPECT_COUNT_REQUIRED',
    );
  return insertBroadcast(
    ctx,
    actor,
    row.mode,
    {
      orgId: row.org_id,
      kind: 'change',
      name: plainLine(row.name).slice(0, 80) || 'Change',
      target: { templateIds: stored.templateIds, expectCount },
      patch: JSON.parse(row.patch),
      notify: row.notify === 1,
      send: 'now',
      ...(stored.message ? { message: stored.message } : {}),
    },
    scope.authority,
    'broadcast.retry',
    {
      detail: { retryOf: row.id },
      resume: { parentId: row.id },
      limit: () => limitChanges(ctx, scope.authority),
    },
  );
}
