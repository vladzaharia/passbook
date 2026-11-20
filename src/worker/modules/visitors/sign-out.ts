import type { z } from 'zod';
import type {
  SignOutRequestSchema,
  SignOutResultSchema,
} from '../../../shared/contracts/access-business.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { policyActor } from '../scan/dto.ts';
import type { ScanActor } from '../scan/guard.ts';
import { markOut } from '../scan/occupancy/mark-out.ts';
import { scanPolicy } from '../scan/rules.ts';
import { stayOf } from './derive.ts';
import { insidePlaces, visitorByPass } from './repo.ts';
import { deskOutGrant } from './repo-write.ts';
import { toVisitor } from './service.ts';

type SignOutRequest = z.infer<typeof SignOutRequestSchema>;
type SignOutResult = z.infer<typeof SignOutResultSchema>;

/** A place the person already left, or one this actor cannot reach, is skipped: the rest still go. */
const skippable = (error: unknown): error is ConflictError | ValidationError =>
  (error instanceof ConflictError && error.code === 'NOT_INSIDE') ||
  (error instanceof ValidationError && error.code === 'SCAN_MARK_OUT_INVALID');

/**
 * POST /scan/sign-out (Desk and above): marks the person out of every tracked place they are in and
 * records a visitor's departure. Someone already out is not an error for a visitor, so a retry is safe.
 */
export async function signOut(
  ctx: ServiceContext,
  actor: ScanActor,
  req: SignOutRequest,
): Promise<SignOutResult> {
  if (!scanPolicy(policyActor(actor), { kind: 'mark_out' }).allow)
    throw new ForbiddenError('Only Desk and above can sign someone out.', 'FORBIDDEN');
  const db = ctx.env.DB;
  const pass = await getPass(db, req.passId, actor.orgId);
  if (!pass || pass.mode !== actor.mode)
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  let stay: number | null = null;
  let marked = 0;
  for (const place of await insidePlaces(db, actor.orgId, pass.id)) {
    try {
      const outcome = await markOut(ctx, actor, {
        idempotencyKey: ctx.ids.ordered(ctx.clock.now()),
        passId: pass.id,
        place,
      });
      marked += 1;
      stay ??= outcome.occupancy?.stayMs ?? null;
    } catch (error) {
      if (!skippable(error)) throw error;
      ctx.log.warn('visitor.sign_out_place_skipped', { orgId: actor.orgId, code: error.code });
    }
  }
  const visit = await visitorByPass(db, actor.orgId, actor.mode, pass.id);
  if (!visit) {
    if (marked === 0) throw new ConflictError('They are already out.', 'NOT_INSIDE');
    return { passId: pass.id, stayMs: stay, tag: req.tag };
  }
  const now = ctx.clock.now();
  const state = toVisitor(visit, now).status;
  if (state === 'in') await deskOutGrant(ctx, actor, visit, { pass, credential: {} }).commit();
  else if (marked === 0 && (state === 'expected' || state === 'no_show'))
    throw new ConflictError('They have not checked in.', 'VISITOR_NOT_IN');
  return {
    passId: pass.id,
    stayMs: stay ?? (state === 'in' ? stayOf(visit.arrivedAt, now) : null),
    tag: req.tag,
  };
}
