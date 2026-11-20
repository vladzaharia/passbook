import type { z } from 'zod';
import type { PutMemberPhotoSchema } from '../../../shared/contracts/check-in.ts';
import { ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import type { ScanActor } from './actor.ts';
import { scanActorChecks, scanPrincipal } from './authority-checks.ts';
import { ROLE_RANK } from './rules.ts';

/**
 * The desk's "Add photo". Only a paired, non-terminal scan device whose signed-in staff (or own role) is
 * Desk or up may write, and only on an active pass of its own org, mode and template scope: any other pass
 * answers as missing. The write is the admin member-photo path, so the pass shows the photo like any other.
 */
export async function captureDeskPhoto(
  ctx: ServiceContext,
  actor: ScanActor,
  passId: string,
  input: z.infer<typeof PutMemberPhotoSchema>,
) {
  const scanner = actor.scanner;
  if (
    actor.principal !== 'scanner' ||
    !scanner ||
    actor.terminal ||
    actor.role === null ||
    ROLE_RANK[actor.role] < ROLE_RANK.desk
  )
    throw new ForbiddenError('Only Desk staff can add photos.', 'PHOTO_ROLE');
  const missing = () => new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const pass = await getPass(ctx.env.DB, passId, actor.orgId);
  if (
    !pass ||
    pass.orgId !== actor.orgId ||
    pass.mode !== actor.mode ||
    (actor.templateIds.length > 0 && !actor.templateIds.includes(pass.templateId))
  )
    throw missing();
  if (pass.status !== 'active' || pass.deletedAt !== null || pass.removedAt !== null)
    throw new ConflictError('This pass is not active.', 'PHOTO_PASS_INACTIVE');
  // Pairing, staff, role (their epochs) and the session are re-checked in the commit batch, not only here.
  const writer = {
    principal: scanPrincipal(actor),
    checks: scanActorChecks(actor, { now: ctx.clock.now(), templateId: pass.templateId }),
  };
  return putMemberPhoto(
    ctx,
    { type: 'scanner', id: scanner.id },
    passId,
    { ...input, includeInPass: false },
    actor.orgId,
    undefined,
    writer,
  );
}
