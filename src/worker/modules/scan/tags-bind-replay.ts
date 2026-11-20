import type { z } from 'zod';
import type {
  ScanTagBindRequestSchema,
  ScanTagBindResultSchema,
} from '../../../shared/contracts/nfc-tags.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assuranceOfSystem } from '../nfc/systems/registry.ts';
import { verifyApproval } from './approval.ts';
import type { ScanActor } from './guard.ts';
import { liveActorGuard, replayRow } from './repo-tags-bind.ts';
import { guardMiss } from './repo-undo-approval-guard.ts';

type BindRequest = z.infer<typeof ScanTagBindRequestSchema>;
type BindResult = z.infer<typeof ScanTagBindResultSchema>;

/** Undo is on the device that assigned the tag, for this long. */
export const TAG_UNDO_MS = 10 * 60_000;

/** A Manager's PIN for this assign: verified here, pinned in the grant, stored nowhere. */
export async function approve(
  ctx: ServiceContext,
  actor: ScanActor,
  approval: BindRequest['approval'],
): Promise<{ id: string; authEpoch: number }> {
  if (actor.terminal || actor.apiKeyId)
    throw new ForbiddenError('A till cannot approve.', 'API_KEY_NO_APPROVAL');
  if (!approval) throw new ForbiddenError('A manager must approve this.', 'TAG_APPROVAL_REQUIRED');
  if (!approval.staffId && actor.settings.staffSignIn)
    throw new ValidationError('Choose the manager.', [], 'PIN_MANAGER_REQUIRED');
  const now = ctx.clock.now();
  const verified = await verifyApproval(ctx, actor, approval, liveActorGuard(actor, now));
  if (!verified) throw (await guardMiss(ctx.env.DB, actor, now)) ?? new ForbiddenError();
  return { id: verified.id, authEpoch: verified.authEpoch };
}

/** What a bind asked for, without the tag's UID or the card's code. */
export const requestHash = (req: BindRequest, ref: string) =>
  sha256Hex(
    JSON.stringify([
      ref,
      req.card,
      req.binding,
      req.move ?? false,
      req.label ?? null,
      ...(req.typeId ? [req.typeId] : []),
    ]),
  );

/** A retry of a bind this device already made: the stored answer, even after Undo. The same key for another request is refused. */
export async function replay(
  ctx: ServiceContext,
  scannerId: string,
  req: BindRequest,
  ref: string,
): Promise<BindResult | null> {
  if (req.preview) return null;
  const row = await replayRow(ctx.env.DB, scannerId, req.idempotencyKey);
  if (!row) return null;
  if (row.requestHash !== (await requestHash(req, ref)))
    throw new ConflictError(
      'That request key was used for another assign.',
      'IDEMPOTENCY_KEY_REUSED',
    );
  const live = row.endedAt === null && ctx.clock.now() - row.boundAt <= TAG_UNDO_MS;
  return {
    status: 'bound',
    hint: row.hint,
    assurance: assuranceOfSystem(row.system),
    scope: row.scope,
    bindingId: row.bindingId,
    card: {
      passId: row.passId,
      title: row.title ?? row.templateName,
      subtitle: row.subtitle,
      templateName: row.templateName,
      holderName: row.holderName,
      photoUrl: null,
    },
    ownerAccount: row.ownerActive,
    skipped: [],
    warnings: [],
    lostAt: row.lostAt,
    undoUntil: live ? row.boundAt + TAG_UNDO_MS : null,
  };
}
