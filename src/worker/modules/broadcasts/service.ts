import { checkInput } from '../../../passkit/template/manifest.ts';
import type {
  BroadcastDto,
  BroadcastPreviewDto,
  BroadcastTarget,
  CreateBroadcastBody,
} from '../../../shared/contracts/broadcasts.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { orgIsActive } from '../orgs/repo.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { BUDGET_WINDOW_MS } from '../passes/change-messages.ts';
import { assertWritableMode, type ScopeArg } from '../passes/scope.ts';
import type { Actor } from '../passes/service.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { targetFilter } from './apply.ts';
import { toDto } from './dto.ts';
import * as repo from './repo.ts';
import { launchBroadcast } from './start.ts';

const MAX_LEAD_MS = 366 * 24 * 3_600_000;

async function requireBroadcast(ctx: ServiceContext, id: string, scope: ScopeArg) {
  const row = await repo.getBroadcast(ctx.env.DB, id, scope);
  if (!row) throw new NotFoundError('Message not found.', 'BROADCAST_NOT_FOUND');
  return row;
}

/** Every targeted template must exist in the org and fit what the broadcast sets. */
async function checkTemplates(ctx: ServiceContext, body: CreateBroadcastBody): Promise<void> {
  for (const templateId of body.target.templateIds) {
    const { manifest } = await resolveTemplate(ctx, body.orgId, templateId);
    if (body.kind === 'message') {
      if (!manifest.messaging)
        throw new ValidationError(
          `${manifest.name} has no message field.`,
          [],
          'MESSAGING_UNSUPPORTED',
        );
      continue;
    }
    const known = new Set(Object.keys(manifest.inputs.properties ?? {}));
    const unknown = Object.keys(body.patch).find((key) => !known.has(key));
    if (unknown)
      throw new ValidationError(
        `${manifest.name} has no input "${unknown}".`,
        [{ path: `patch.${unknown}`, message: 'Unknown input.' }],
        'BROADCAST_UNKNOWN_INPUT',
      );
    // Only the keys the change sets are checked; the rest of the input is each pass's own.
    const bad = checkInput(manifest, body.patch).find((issue) =>
      Object.hasOwn(body.patch, issue.path?.split('/')[0] ?? ''),
    );
    if (bad)
      throw new ValidationError(
        `${manifest.name}: ${bad.path} ${bad.message}`,
        [{ path: `patch.${bad.path}`, message: bad.message }],
        'BROADCAST_INVALID_INPUT',
      );
  }
}

function checkTime(ctx: ServiceContext, at: number): void {
  const now = ctx.clock.now();
  if (at <= now) throw new ValidationError('Pick a time in the future.', [], 'BROADCAST_PAST');
  if (at > now + MAX_LEAD_MS)
    throw new ValidationError('Pick a time within a year.', [], 'BROADCAST_TOO_FAR');
}

const nameOf = (body: CreateBroadcastBody) =>
  body.name ??
  (body.kind === 'message'
    ? String(body.patch.message ?? '')
        .trim()
        .slice(0, 60) || 'Clear message'
    : 'Scheduled change');

export async function createBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  mode: Mode,
  body: CreateBroadcastBody,
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
    action: 'broadcast.create',
    targetType: 'broadcast',
    targetId: id,
    detail: { kind: body.kind, send: body.send, mode },
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
  scope: ScopeArg,
): Promise<BroadcastDto> {
  const row = await requireBroadcast(ctx, id, scope);
  assertWritableMode(scope, row.mode, 'broadcast');
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
  return getBroadcastDto(ctx, id, scope);
}

export async function cancelBroadcast(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  scope: ScopeArg,
): Promise<BroadcastDto> {
  const row = await requireBroadcast(ctx, id, scope);
  assertWritableMode(scope, row.mode, 'broadcast');
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
  const counts = await repo.countTarget(
    ctx.env.DB,
    filter,
    ctx.clock.now(),
    ctx.clock.now() - BUDGET_WINDOW_MS,
    limit,
  );
  return { ...counts, limit };
}
