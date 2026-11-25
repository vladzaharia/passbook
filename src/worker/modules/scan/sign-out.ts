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
import { policyActor } from './dto.ts';
import type { ScanActor } from './guard.ts';
import { passInScope } from './history-scope.ts';
import { markOut } from './occupancy/mark-out.ts';
import { insidePlaces } from './repo-sign-out.ts';
import { scanPolicy } from './rules.ts';

type SignOutRequest = z.infer<typeof SignOutRequestSchema>;
type SignOutResult = z.infer<typeof SignOutResultSchema>;

/** A place the person already left, or one this actor cannot reach, is skipped: the rest still go. */
const skippable = (error: unknown): error is ConflictError | ValidationError =>
  (error instanceof ConflictError && error.code === 'NOT_INSIDE') ||
  (error instanceof ValidationError && error.code === 'SCAN_MARK_OUT_INVALID');

/**
 * POST /scan/sign-out (Desk and above): marks the person out of every tracked place they are in.
 * No visit is recorded; a pass with nothing to mark out is 409 NOT_INSIDE.
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
  if (!pass || pass.mode !== actor.mode || !passInScope(actor, pass.templateId))
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
      ctx.log.warn('scan.sign_out_place_skipped', { orgId: actor.orgId, code: error.code });
    }
  }
  if (marked === 0) throw new ConflictError('They are already out.', 'NOT_INSIDE');
  return { passId: pass.id, stayMs: stay, tag: req.tag };
}
