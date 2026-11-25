import { z } from 'zod';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { orgIsReadable } from '../orgs/repo.ts';
import { sendHoldNotice } from './notify.ts';
import { canRelease } from './policy.ts';
import {
  closeHold,
  type HoldBy,
  type HoldRow,
  holdRow,
  insertHold,
  listHoldRows,
  orgExists,
  passHeld,
  passInOrg,
} from './repo-holds.ts';

export type { HoldBy, HoldRow };

const ReasonSchema = z.string().trim().min(1).max(500);

/** An org admin acts only on her own org and only with `org:manage`; the grant checks the capability it is given. */
const mayAct = (by: HoldBy, orgId: string): boolean =>
  by.kind === 'platform' ||
  (by.authority.orgId === orgId && by.authority.capability === 'org:manage');

/**
 * Places a hold on an org (`passId` null) or one pass. A hold pauses retention deletes, guest-plan pass deletion and
 * erasure in its scope. An org admin (`org:manage`) places org holds; a platform admin places holds the org
 * cannot release. Every `org:manage` member is emailed.
 */
export async function placeHold(
  ctx: ServiceContext,
  orgId: string,
  input: { passId?: string | null; reason: string },
  by: HoldBy,
): Promise<{ id: string }> {
  if (!mayAct(by, orgId)) throw new ForbiddenError();
  const reason = ReasonSchema.safeParse(input.reason);
  if (!reason.success)
    throw new ValidationError('Invalid hold.', [
      { path: 'reason', message: 'Give a reason, up to 500 characters.' },
    ]);
  // PassBook may preserve a closed org's data before its purge; an org cannot act once it is closed.
  const reachable =
    (await orgIsReadable(ctx.env.DB, orgId)) ||
    (by.kind === 'platform' && (await orgExists(ctx.env.DB, orgId)));
  if (!reachable) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const passId = input.passId ?? null;
  if (passId !== null && !(await passInOrg(ctx.env.DB, orgId, passId)))
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const id = ctx.ids.id();
  await insertHold(
    ctx,
    by,
    { id, orgId, passId, reason: reason.data, now: ctx.clock.now() },
    {
      action: 'retention.hold.place',
      targetId: id,
      // No reason, no pass id: audit detail stays free of free text.
      detail: JSON.stringify({ scope: passId === null ? 'org' : 'pass', by: by.kind }),
    },
  );
  await sendHoldNotice(ctx, orgId, true);
  return { id };
}

/** An org admin cannot release a platform hold; a platform admin releases any. */
export async function releaseHold(
  ctx: ServiceContext,
  orgId: string,
  holdId: string,
  by: HoldBy,
): Promise<void> {
  if (!mayAct(by, orgId)) throw new ForbiddenError();
  const hold = await holdRow(ctx.env.DB, orgId, holdId);
  if (!hold || hold.releasedAt !== null)
    throw new NotFoundError('Hold not found.', 'HOLD_NOT_FOUND');
  if (!canRelease(hold.placedByKind, by.kind))
    throw new ForbiddenError(
      'PassBook placed this hold. Ask PassBook to release it.',
      'RETENTION_HOLD_PLATFORM',
    );
  await closeHold(
    ctx,
    by,
    { id: holdId, orgId, now: ctx.clock.now() },
    {
      action: 'retention.hold.release',
      targetId: holdId,
      detail: JSON.stringify({ scope: hold.passId === null ? 'org' : 'pass', by: by.kind }),
    },
  );
  await sendHoldNotice(ctx, orgId, false);
}

export const listHolds = (ctx: ServiceContext, orgId: string): Promise<HoldRow[]> =>
  listHoldRows(ctx.env.DB, orgId);

/** True while an org-wide hold or a hold on this pass is active: deletes and erasure skip it. */
export const isPassHeld = (ctx: ServiceContext, orgId: string, passId: string): Promise<boolean> =>
  passHeld(ctx.env.DB, orgId, passId);
