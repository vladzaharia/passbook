import type { Tag } from '../../../shared/contracts/nfc-tags.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { ownerActiveCheck } from '../scan/repo-tags-bind.ts';
import { assertBindableIfScannable, assertPassTakesTag } from './pass-state.ts';
import { bindPolicy, tagsRefusal } from './policy.ts';
import { ownerIsActive } from './repo-enrollments.ts';
import { activeBinding, type BindingRow, type PassFacts, passFacts } from './repo-tag-bindings.ts';
import { orgTagCount, type TagRow, tagByRef, tagView } from './repo-tags.ts';
import {
  addBind,
  type BindPlan,
  bindChecks,
  type TagActor,
  type TagAuthority,
  tagActorOf,
  tagGrant,
} from './repo-tags-write.ts';
import { UID_SYSTEM } from './systems/uid.ts';

export const TAGS_PER_ORG_MODE = 50_000;
const ATTEMPTS = 3;

export interface BindRequest {
  /** The tag's UID as hex. The caller normalizes a reader's text first (`normalizeTagId`). */
  uid: string;
  passId: string;
  scope: 'pass' | 'user';
  label?: string | null | undefined;
  /** Take the tag from another holder, or from a lost report. */
  move?: boolean | undefined;
  /** The type of a new tag; absent: the only type that fits, else the org's default, else Standard. */
  typeId?: string | undefined;
}

export type BindStatus = 'bound' | 'already_bound' | 'replaced' | 'moved';

const notFound = () => new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
const conflict = (message: string, code: string) => new ConflictError(message, code);

const sameTarget = (b: BindingRow, p: PassFacts, scope: 'pass' | 'user') =>
  b.scope === scope && (scope === 'pass' ? b.passId === p.id : b.userId === p.ownerUserId);

/** The same person: the same pass, or two passes of one owner. */
const sameHolder = (b: BindingRow, p: PassFacts) =>
  b.passId === p.id || (p.ownerUserId !== null && (b.userId ?? b.passOwnerId) === p.ownerUserId);

type Decision =
  | { status: 'already_bound'; tagId: string }
  | { status: Exclude<BindStatus, 'already_bound'>; end: BindPlan['end'] };

/** What a bind does given the tag's state: nothing, a plain bind, or an end-and-bind. */
export function decideBind(
  tag: TagRow | null,
  active: BindingRow | null,
  pass: PassFacts,
  req: Pick<BindRequest, 'scope' | 'move'>,
  now: number,
): Decision {
  if (tag?.status === 'retired')
    throw conflict('This tag was retired. An admin can restore it.', 'TAG_RETIRED');
  // A binding past its expiry is over: it ends in this bind's batch, whoever binds next.
  const lapsed = active !== null && active.expiresAt !== null && active.expiresAt <= now;
  if (active && lapsed) {
    if (tag?.lostAt != null && !req.move) throw conflict('This tag was reported lost.', 'TAG_LOST');
    return { status: 'bound', end: { id: active.id, cause: 'expired' } };
  }
  if (active) {
    if (sameTarget(active, pass, req.scope))
      return { status: 'already_bound', tagId: active.tagId };
    if (sameHolder(active, pass))
      return { status: 'replaced', end: { id: active.id, cause: 'replaced' } };
    if (!req.move)
      throw conflict(
        'The tag belongs to someone else. A manager can move it.',
        'TAG_HELD_BY_OTHER',
      );
    return { status: 'moved', end: { id: active.id, cause: 'moved' } };
  }
  if (tag?.lostAt != null && !req.move) throw conflict('This tag was reported lost.', 'TAG_LOST');
  return { status: 'bound', end: null };
}

/** The refusals the tag triggers raise inside a batch (migration 0086). */
export function triggerRefusal(error: unknown): AppError | null {
  const text = error instanceof Error ? error.message : '';
  if (text.includes('tag_binding_limit'))
    return conflict('This pass or person has the most tags allowed.', 'TAG_BINDING_LIMIT');
  if (text.includes('tag_lost')) return conflict('This tag was reported lost.', 'TAG_LOST');
  if (text.includes('tag_retired'))
    return conflict('This tag was retired. An admin can restore it.', 'TAG_RETIRED');
  if (text.includes('tag_binding_owner'))
    return conflict('The pass changed hands. Start again.', 'TAG_HOLDER_CHANGED');
  if (text.includes('tag_binding_tenant')) return notFound();
  if (text.includes('tag_type_limit'))
    return conflict('This pass has its tag of that type already.', 'TAG_TYPE_LIMIT');
  if (text.includes('tag_type_scope'))
    return conflict(
      "This tag type can't be assigned that way. Choose another type.",
      'TAG_TYPE_SCOPE',
    );
  if (text.includes('tag_type_template'))
    return conflict("This tag type can't go on this pass.", 'TAG_TYPE_MISMATCH');
  if (text.includes('tag_type_archived'))
    return conflict('This tag type is archived.', 'TAG_TYPE_ARCHIVED');
  if (text.includes('tag_type_system'))
    return conflict(
      'This tag type is for another kind of tag. Choose another type.',
      'TAG_TYPE_SYSTEM',
    );
  if (text.includes('tag_type_tenant'))
    return new NotFoundError('Tag type not found.', 'TAG_TYPE_NOT_FOUND');
  return null;
}

/** Commits a tag grant, answering a trigger refusal with its stable code. */
export async function commitTag(g: { commit(): Promise<unknown> }): Promise<void> {
  try {
    await g.commit();
  } catch (error) {
    throw triggerRefusal(error) ?? error;
  }
}

/**
 * Binds a tag to a pass, or to the pass's owner as a person, for a console admin. A tag has one active
 * binding: a second bind of the same holder replaces it, another holder's needs `move`. Concurrent binds of
 * one tag commit one and refuse the rest from the unique index. Scanner and remote enrollment build the
 * same plan under their own grants (`addBind`).
 */
export async function bindTag(
  ctx: ServiceContext,
  authority: TagAuthority,
  req: BindRequest,
): Promise<{ status: BindStatus; tag: Tag }> {
  const { orgId, mode } = authority;
  const off = await tagsRefusal(ctx, orgId);
  if (off) throw off;
  await ensureCredentialRefKeyset(ctx.env.DB, ctx.env);
  const { ref, hint } = await UID_SYSTEM.identify(ctx.env, orgId, mode, req.uid);
  for (let attempt = 1; ; attempt++) {
    const pass = await passFacts(ctx.env.DB, req.passId);
    if (!pass || pass.orgId !== orgId || pass.mode !== mode || pass.deletedAt !== null)
      throw notFound();
    if (req.scope === 'user' && !(await ownerIsActive(ctx.env.DB, pass.ownerUserId)))
      throw new ValidationError(
        'This person has no account yet. Assign the tag to the pass instead.',
        [],
        'TAG_NO_ACCOUNT',
      );
    await assertBindableIfScannable(ctx, orgId, pass.id);
    const candidate = await assertPassTakesTag(ctx, orgId, pass.id);
    const tag = await tagByRef(ctx.env.DB, orgId, mode, ref);
    // A typed ID is a UID, and a Secure tag is never its UID: it must be tapped.
    if (tag && tag.system !== 'uid')
      throw conflict('This is a Secure tag. Tap it on a scanner.', 'TAG_SECURE_NEEDS_TAP');
    const active = tag ? await activeBinding(ctx.env.DB, tag.id) : null;
    const decision = decideBind(tag, active, pass, req, ctx.clock.now());
    if (decision.status === 'already_bound')
      return { status: 'already_bound', tag: await shown(ctx, orgId, mode, decision.tagId) };
    const policy = await bindPolicy(ctx, {
      orgId,
      passId: pass.id,
      candidate,
      scope: req.scope,
      system: 'uid',
      tag,
      typeId: req.typeId,
      ending: decision.end?.id ?? null,
      typed: true,
    });
    if (!tag && (await orgTagCount(ctx.env.DB, orgId, mode)) >= TAGS_PER_ORG_MODE)
      throw conflict('This organization has the most tags allowed.', 'TAG_LIMIT');
    const plan: BindPlan = {
      tagId: tag?.id ?? ctx.ids.id(),
      newTag: tag
        ? null
        : { ref, hint, label: req.label ?? null, system: 'uid', typeId: policy.type?.id ?? null },
      expiryDays: policy.expiryDays,
      endsAt: policy.endsAt,
      endLapsed: policy.lapsed,
      bindingId: ctx.ids.id(),
      passId: pass.id,
      scope: req.scope,
      userId: req.scope === 'user' ? pass.ownerUserId : null,
      end: decision.end,
      holderGeneration: pass.credentialGeneration,
      holderOwner: pass.ownerUserId,
      clearsLost: tag?.lostAt != null,
      source: 'admin',
      actor: tagActorOf(authority) satisfies TagActor,
      scannerId: null,
      orgId,
      mode,
    };
    const g = tagGrant(ctx, 'org_mode.nfc.tag.bind', authority, [
      ...bindChecks(plan),
      ...(plan.userId ? [ownerActiveCheck(plan.userId)] : []),
    ]);
    const insert = addBind(g, ctx, plan);
    try {
      const results = await g.commit();
      if ((results[g.indexOf(insert)]?.results?.length ?? 0) === 1)
        return { status: decision.status, tag: await shown(ctx, orgId, mode, plan.tagId) };
    } catch (error) {
      const refusal = triggerRefusal(error);
      if (refusal) throw refusal;
      const lost =
        classifyD1Error(error)?.kind === 'unique' ||
        (error instanceof AppError && error.code === 'TAG_HOLDER_CHANGED');
      if (!lost || attempt >= ATTEMPTS) throw error;
      continue;
    }
    // The tag row came from a concurrent bind under another id: read again.
    if (attempt >= ATTEMPTS) throw conflict('The tag changed. Try again.', 'TAG_HOLDER_CHANGED');
  }
}

async function shown(ctx: ServiceContext, orgId: string, mode: 'live' | 'test', id: string) {
  const tag = await tagView(ctx.env.DB, orgId, mode, id);
  if (!tag) throw new NotFoundError('Tag not found.', 'TAG_NOT_FOUND');
  return tag;
}
