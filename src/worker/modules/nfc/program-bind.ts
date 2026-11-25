import {
  TAG_PROGRAM_BIND_REFUSALS,
  type TagProgramBindRefusal,
} from '../../../shared/contracts/nfc-tag-programs.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertBindableIfScannable } from './pass-state.ts';
import { bindPolicy } from './policy.ts';
import type { ProgramAuthority } from './repo-programs.ts';
import { passFacts } from './repo-tag-bindings.ts';
import { type BindPlan, bindChecks } from './repo-tags-write.ts';

/**
 * The bind a programmed tag may be committed with: the plan, the type the tag gets and the checks the grant adds.
 * Or the reason it was not planned (the pass is gone, voided or expired, a right is missing, the tag type
 * refuses): the tag is still programmed, as a spare, and the answer carries the reason.
 */
export type BindOutcome =
  | {
      plan: BindPlan;
      checks: ReturnType<typeof bindChecks>;
      typeId: string | null;
    }
  | { refusal: TagProgramBindRefusal };

const known = (code: string): TagProgramBindRefusal =>
  (TAG_PROGRAM_BIND_REFUSALS as readonly string[]).includes(code)
    ? (code as TagProgramBindRefusal)
    : 'TAG_BIND_REFUSED';

/**
 * A new tag has no binding to end and no loss to clear, and its row is made in the same batch. The same rules as
 * a scanner bind: the actor's right to assign (to a person needs the wider one), the pass takes a tag, and the
 * tag type's fit, scope, per-pass limit, expiry and lapsed bindings (`bindPolicy`).
 */
export async function planBind(
  ctx: ServiceContext,
  a: ProgramAuthority,
  tagId: string,
  req: { passId: string; scope: 'pass' | 'user' },
  keysetTypeId: string | null,
): Promise<BindOutcome> {
  const facts = await passFacts(ctx.env.DB, req.passId);
  if (!facts || facts.orgId !== a.orgId || facts.mode !== a.mode || facts.deletedAt !== null)
    return { refusal: 'PASS_NOT_FOUND' };
  if (a.actor.type !== 'scanner') return { refusal: 'TAG_ASSIGN_FORBIDDEN' };
  if (!(req.scope === 'user' ? a.rights.assignAll : a.rights.assign))
    return { refusal: 'TAG_ASSIGN_FORBIDDEN' };
  if (req.scope === 'user' && !facts.ownerUserId) return { refusal: 'TAG_NO_ACCOUNT' };
  let policy: Awaited<ReturnType<typeof bindPolicy>>;
  try {
    await assertBindableIfScannable(ctx, a.orgId, req.passId);
    policy = await bindPolicy(ctx, {
      orgId: a.orgId,
      passId: req.passId,
      scope: req.scope,
      system: 'sun',
      tag: null,
      ...(keysetTypeId ? { typeId: keysetTypeId } : {}),
      ending: null,
    });
  } catch (error) {
    if (error instanceof AppError) return { refusal: known(error.code) };
    throw error;
  }
  const plan: BindPlan = {
    tagId,
    newTag: null,
    bindingId: ctx.ids.id(),
    passId: req.passId,
    scope: req.scope,
    userId: req.scope === 'user' ? facts.ownerUserId : null,
    end: null,
    endLapsed: policy.lapsed,
    expiryDays: policy.expiryDays,
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
  return {
    plan,
    checks: bindChecks(plan),
    typeId: policy.type?.id ?? keysetTypeId,
  };
}
