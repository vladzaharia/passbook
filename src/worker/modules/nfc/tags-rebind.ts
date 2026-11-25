import type { Tag } from '../../../shared/contracts/nfc-tags.ts';
import { exists } from '../../platform/authority-cond.ts';
import { classifyD1Error } from '../../platform/db.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { assertBindable } from './pass-state.ts';
import { bindPolicy, tagsRefusal } from './policy.ts';
import { ownerIsActive } from './repo-enrollments.ts';
import { activeBinding, bindingTarget, type PassFacts, passFacts } from './repo-tag-bindings.ts';
import { lastEndedBinding } from './repo-tag-history.ts';
import { tagTarget, tagView } from './repo-tags.ts';
import {
  addBind,
  type BindPlan,
  bindChecks,
  type SessionTagAuthority,
  type TagAuthority,
  tagActorOf,
  tagAuditActorOf,
  tagGrant,
} from './repo-tags-write.ts';
import { decideBind, triggerRefusal } from './tags.ts';

/** Undo on remove is open for this long after the tag was taken off. */
export const REMOVE_UNDO_MS = 10 * 60_000;
const ATTEMPTS = 3;

const tagGone = () => new NotFoundError('Tag not found.', 'TAG_NOT_FOUND');
const passGone = () => new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');

async function livePass(ctx: ServiceContext, a: TagAuthority, passId: string): Promise<PassFacts> {
  const pass = await passFacts(ctx.env.DB, passId);
  if (!pass || pass.orgId !== a.orgId || pass.mode !== a.mode || pass.deletedAt !== null)
    throw passGone();
  await assertBindable(ctx, a.orgId, passId);
  return pass;
}

/**
 * Binds an existing tag to a pass or to the pass's owner: what Undo and a change of "works with" do. The
 * tag's own rules apply (`decideBind`): the same holder's binding is replaced, another's is refused.
 */
export async function place(
  ctx: ServiceContext,
  a: TagAuthority,
  tagId: string,
  pass: PassFacts,
  scope: 'pass' | 'user',
  rebind: { from: 'pass' | 'user' } | null,
  /** A first assignment of a spare: its own grant purpose, and any active binding refuses. */
  spare = false,
): Promise<Tag> {
  const off = await tagsRefusal(ctx, a.orgId);
  if (off) throw off;
  if (scope === 'user' && !(await ownerIsActive(ctx.env.DB, pass.ownerUserId)))
    throw new ValidationError(
      'This person has no account yet. Assign the tag to the pass instead.',
      [],
      'TAG_NO_ACCOUNT',
    );
  for (let attempt = 1; ; attempt++) {
    const tag = await tagTarget(ctx.env.DB, tagId);
    if (!tag || tag.orgId !== a.orgId || tag.mode !== a.mode) throw tagGone();
    const active = await activeBinding(ctx.env.DB, tagId);
    if (spare && active)
      throw new ConflictError('This tag is already assigned.', 'TAG_ALREADY_ASSIGNED');
    const decision = decideBind(tag, active, pass, { scope, move: false }, ctx.clock.now());
    if (decision.status === 'already_bound') return shown(ctx, a, tagId);
    const policy = await bindPolicy(ctx, {
      orgId: a.orgId,
      passId: pass.id,
      scope,
      system: tag.system,
      tag,
      ending: decision.end?.id ?? null,
    });
    const plan: BindPlan = {
      tagId,
      newTag: null,
      bindingId: ctx.ids.id(),
      passId: pass.id,
      scope,
      userId: scope === 'user' ? pass.ownerUserId : null,
      end: decision.end,
      holderGeneration: pass.credentialGeneration,
      holderOwner: pass.ownerUserId,
      clearsLost: false,
      expiryDays: policy.expiryDays,
      endsAt: policy.endsAt,
      endLapsed: policy.lapsed,
      audited: rebind !== null,
      source: 'admin',
      actor: tagActorOf(a),
      scannerId: null,
      orgId: a.orgId,
      mode: a.mode,
    };
    const g = tagGrant(
      ctx,
      spare ? 'org_mode.nfc.tag.bind' : 'org_mode.nfc.tag.rebind',
      a,
      bindChecks(plan),
    );
    const insert = addBind(g, ctx, plan);
    if (rebind)
      grantedAudit(
        g,
        ctx,
        {
          orgId: a.orgId,
          ...tagAuditActorOf(a),
          action: 'tag.rebind',
          targetType: 'tag',
          targetId: tagId,
          detail: { from: rebind.from, to: scope, passId: pass.id },
        },
        [exists('tag_bindings', { id: plan.bindingId })],
      );
    try {
      const results = await g.commit();
      if ((results[g.indexOf(insert)]?.results?.length ?? 0) === 1) return shown(ctx, a, tagId);
    } catch (error) {
      const refusal = triggerRefusal(error);
      if (refusal) throw refusal;
      if (classifyD1Error(error)?.kind !== 'unique' || attempt >= ATTEMPTS) throw error;
      continue;
    }
    if (attempt >= ATTEMPTS)
      throw new ConflictError('The tag changed. Try again.', 'TAG_HOLDER_CHANGED');
  }
}

async function shown(ctx: ServiceContext, a: TagAuthority, id: string): Promise<Tag> {
  const tag = await tagView(ctx.env.DB, a.orgId, a.mode, id);
  if (!tag) throw tagGone();
  return tag;
}

/**
 * Changes what an active binding works with. `pass` narrows a person-wide tag to one pass (`passId`, or the
 * binding's anchor); `user` widens a pass tag to the pass's owner. Another holder's pass is refused.
 */
export async function changeBinding(
  ctx: ServiceContext,
  a: SessionTagAuthority,
  bindingId: string,
  req: { binding: 'pass' | 'user'; passId?: string | undefined },
): Promise<Tag> {
  const binding = await bindingTarget(ctx.env.DB, bindingId);
  if (!binding || binding.orgId !== a.orgId || binding.mode !== a.mode || binding.ended)
    throw tagGone();
  const pass = await livePass(ctx, a, req.passId ?? binding.passId);
  return place(ctx, a, binding.tagId, pass, req.binding, { from: binding.scope });
}

/** Undo on remove: puts the tag back on what it was removed from, by the same admin, within 10 minutes. */
export async function rebindRemoved(
  ctx: ServiceContext,
  a: SessionTagAuthority,
  passId: string,
  req: { tagId: string; binding: 'pass' | 'user' },
): Promise<Tag> {
  const pass = await livePass(ctx, a, passId);
  const tag = await tagTarget(ctx.env.DB, req.tagId);
  if (!tag || tag.orgId !== a.orgId || tag.mode !== a.mode) throw tagGone();
  const last = await lastEndedBinding(ctx.env.DB, tag.id);
  const removedByYou =
    last !== null &&
    last.endCause === 'admin' &&
    last.endedByType === 'user' &&
    last.endedBy === a.userId &&
    last.scope === req.binding &&
    last.holderGeneration === pass.credentialGeneration &&
    last.holderOwner === pass.ownerUserId &&
    (last.scope === 'user' ? last.userId === pass.ownerUserId : last.passId === pass.id);
  const active = await activeBinding(ctx.env.DB, tag.id);
  if (active) {
    // A second Undo finds the tag back where it was; anything else is not an undo.
    const same =
      active.scope === req.binding &&
      (req.binding === 'pass' ? active.passId === pass.id : active.userId === pass.ownerUserId);
    if (!same) throw new ConflictError('The tag was assigned again.', 'TAG_ALREADY_ASSIGNED');
    return shown(ctx, a, tag.id);
  }
  if (!last || !removedByYou || ctx.clock.now() - last.endedAt > REMOVE_UNDO_MS)
    throw new ForbiddenError('Undo timed out. Add the tag again.', 'TAG_UNDO_EXPIRED');
  return place(ctx, a, tag.id, pass, req.binding, null);
}
