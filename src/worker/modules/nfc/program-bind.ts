import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertBindableIfScannable } from './pass-state.ts';
import type { ProgramAuthority } from './repo-programs.ts';
import { passFacts } from './repo-tag-bindings.ts';
import { type BindPlan, bindChecks } from './repo-tags-write.ts';

/**
 * The bind a programmed tag may be committed with: the plan, and the checks the grant adds. Or the reason it
 * was not planned (the pass is gone, voided, expired, or has no account for a user scope): the tag is still
 * programmed, as a spare, and the answer carries the reason.
 */
export type BindOutcome =
  | { plan: BindPlan; checks: ReturnType<typeof bindChecks> }
  | { refusal: string };

/** A new tag has no binding to end and no loss to clear, and its row is made in the same batch. */
export async function planBind(
  ctx: ServiceContext,
  a: ProgramAuthority,
  tagId: string,
  req: { passId: string; scope: 'pass' | 'user' },
): Promise<BindOutcome> {
  const facts = await passFacts(ctx.env.DB, req.passId);
  if (!facts || facts.orgId !== a.orgId || facts.mode !== a.mode || facts.deletedAt !== null)
    return { refusal: 'PASS_NOT_FOUND' };
  if (a.actor.type !== 'scanner') return { refusal: 'TAG_ASSIGN_FORBIDDEN' };
  try {
    await assertBindableIfScannable(ctx, a.orgId, req.passId);
  } catch (error) {
    if (error instanceof AppError) return { refusal: error.code };
    throw error;
  }
  if (req.scope === 'user' && !facts.ownerUserId) return { refusal: 'TAG_NO_ACCOUNT' };
  const plan: BindPlan = {
    tagId,
    newTag: null,
    bindingId: ctx.ids.id(),
    passId: req.passId,
    scope: req.scope,
    userId: req.scope === 'user' ? facts.ownerUserId : null,
    end: null,
    holderGeneration: facts.credentialGeneration,
    holderOwner: facts.ownerUserId,
    clearsLost: false,
    source: 'scanner',
    actor: a.actor.staffId
      ? { type: 'staff', id: a.actor.staffId }
      : { type: 'scanner', id: a.actor.id },
    scannerId: a.actor.id,
    orgId: a.orgId,
    mode: a.mode,
  };
  return { plan, checks: bindChecks(plan) };
}
