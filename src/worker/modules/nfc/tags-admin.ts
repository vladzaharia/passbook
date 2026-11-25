import type { Tag } from '../../../shared/contracts/nfc-tags.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { assertPassTakesTag } from './pass-state.ts';
import { bindPolicy, tagsRefusal } from './policy.ts';
import { activeBinding, bindingTarget, lostBinding, passFacts } from './repo-tag-bindings.ts';
import { tagTarget, tagView } from './repo-tags.ts';
import {
  addBind,
  bindChecks,
  endBinding,
  type SessionTagAuthority,
  type TagAuthority,
  tagActorOf,
  tagAuditActorOf,
  tagGrant,
} from './repo-tags-write.ts';
import { commitTag } from './tags.ts';

/** The captured console session holds passes:operate for this org. */
export function tagAuthorityOf(authority: TenantPassWrite): SessionTagAuthority {
  if (authority.kind !== 'session' || authority.capability !== 'passes:operate')
    throw new ForbiddenError();
  return { ...authority, capability: 'passes:operate' };
}

/** A console session holding passes:operate, or a key holding `nfc:write` (a key acts as `k:<keyId>`). */
export function tagWriterOf(authority: TenantPassWrite): TagAuthority {
  if (authority.kind === 'api_key') {
    if (authority.scope !== 'nfc:write') throw new ForbiddenError();
    return { ...authority, scope: 'nfc:write' };
  }
  return tagAuthorityOf(authority);
}

const notFound = () => new NotFoundError('Tag not found.', 'TAG_NOT_FOUND');

async function tagIn(ctx: ServiceContext, a: TagAuthority, id: string) {
  const tag = await tagTarget(ctx.env.DB, id);
  if (!tag || tag.orgId !== a.orgId || tag.mode !== a.mode) throw notFound();
  return tag;
}

async function shown(ctx: ServiceContext, a: TagAuthority, id: string): Promise<Tag> {
  const tag = await tagView(ctx.env.DB, a.orgId, a.mode, id);
  if (!tag) throw notFound();
  return tag;
}

const audit = (
  g: ReturnType<typeof tagGrant>,
  ctx: ServiceContext,
  a: TagAuthority,
  action: string,
  tagId: string,
  detail: Record<string, unknown> = {},
) =>
  grantedAudit(g, ctx, {
    orgId: a.orgId,
    ...tagAuditActorOf(a),
    action,
    targetType: 'tag',
    targetId: tagId,
    detail,
  });

/** Ends a binding by its id. The tag stays; a later bind may reuse it. */
export async function unbindTag(
  ctx: ServiceContext,
  a: TagAuthority,
  bindingId: string,
): Promise<Tag> {
  const binding = await bindingTarget(ctx.env.DB, bindingId);
  if (!binding || binding.orgId !== a.orgId || binding.mode !== a.mode || binding.ended)
    throw notFound();
  const g = tagGrant(ctx, 'org_mode.nfc.tag.unbind', a);
  endBinding(g, binding, 'admin', tagActorOf(a), ctx.clock.now());
  audit(g, ctx, a, 'tag.unbind', binding.tagId, { cause: 'admin', scope: binding.scope });
  await commitTag(g);
  return shown(ctx, a, binding.tagId);
}

/** The tag is lost: its binding ends with that cause, the tag keeps the mark, and a read answers "reported lost" until it is restored. */
export async function reportTagLost(
  ctx: ServiceContext,
  a: TagAuthority,
  id: string,
): Promise<Tag> {
  const tag = await tagIn(ctx, a, id);
  if (tag.lostAt !== null) return shown(ctx, a, id);
  const active = await activeBinding(ctx.env.DB, tag.id);
  if (!active) throw new ConflictError('The tag is not assigned.', 'TAG_NOT_ASSIGNED');
  const now = ctx.clock.now();
  const g = tagGrant(ctx, 'org_mode.nfc.tag.lost', a, [
    exactlyOne('nfc_tags', { id, lost_at: null }),
  ]);
  endBinding(g, active, 'lost', tagActorOf(a), now);
  g.update('nfc_tags', { set: { lost_at: now, lost_by: tagActorOf(a).id }, where: { id } });
  audit(g, ctx, a, 'tag.lost', tag.id, { scope: active.scope });
  await commitTag(g);
  return shown(ctx, a, id);
}

/** The tag stops opening anything and cannot be bound until restored. Nothing is tombstoned: only this row changes. */
export async function retireTag(
  ctx: ServiceContext,
  a: SessionTagAuthority,
  id: string,
): Promise<Tag> {
  const tag = await tagIn(ctx, a, id);
  if (tag.status === 'retired') return shown(ctx, a, id);
  const g = tagGrant(ctx, 'org_mode.nfc.tag.retire', a, [
    exactlyOne('nfc_tags', { id, status: 'active' }),
  ]);
  const now = ctx.clock.now();
  // Set-based: whatever is active when the batch runs ends, even a bind that raced this read.
  g.joined('tag_bindings', {
    via: 'tag_id',
    where: { tag_id: id, ended_at: null },
    set: { ended_at: now, ended_by_type: 'user', ended_by: a.userId, end_cause: 'tag_retired' },
  });
  g.update('nfc_tags', {
    set: { status: 'retired', status_at: now },
    where: { id, status: 'active' },
  });
  audit(g, ctx, a, 'tag.retire', id);
  await commitTag(g);
  return shown(ctx, a, id);
}

/**
 * A retired tag becomes active again, unassigned. A lost tag works with what it was bound to again, if
 * the pass still has the holder it had when bound.
 */
export async function restoreTag(ctx: ServiceContext, a: TagAuthority, id: string): Promise<Tag> {
  const tag = await tagIn(ctx, a, id);
  const now = ctx.clock.now();
  if (tag.status === 'retired') {
    const g = tagGrant(ctx, 'org_mode.nfc.tag.restore', a, [
      exactlyOne('nfc_tags', { id, status: 'retired' }),
    ]);
    g.update('nfc_tags', {
      set: { status: 'active', status_at: now },
      where: { id, status: 'retired' },
    });
    audit(g, ctx, a, 'tag.restore', id, { from: 'retired' });
    await commitTag(g);
    return shown(ctx, a, id);
  }
  if (tag.lostAt === null) return shown(ctx, a, id);
  const off = await tagsRefusal(ctx, a.orgId);
  if (off) throw off;
  const last = await lostBinding(ctx.env.DB, id);
  const pass = last ? await passFacts(ctx.env.DB, last.passId) : null;
  const holderBack =
    last !== null &&
    pass?.orgId === a.orgId &&
    pass.mode === a.mode &&
    pass.deletedAt === null &&
    pass.credentialGeneration === last.holderGeneration &&
    pass.ownerUserId === last.holderOwner;
  if (!last || !pass || !holderBack)
    throw new ConflictError('The pass changed hands. Start again.', 'TAG_HOLDER_CHANGED');
  const candidate = await assertPassTakesTag(ctx, a.orgId, pass.id);
  const policy = await bindPolicy(ctx, {
    orgId: a.orgId,
    passId: pass.id,
    candidate,
    scope: last.scope,
    system: tag.system,
    tag,
    ending: null,
  });
  const plan = {
    tagId: id,
    newTag: null,
    bindingId: ctx.ids.id(),
    passId: pass.id,
    scope: last.scope,
    userId: last.userId,
    end: null,
    holderGeneration: last.holderGeneration,
    holderOwner: last.holderOwner,
    clearsLost: true,
    expiryDays: policy.expiryDays,
    endsAt: policy.endsAt,
    endLapsed: policy.lapsed,
    audited: true,
    source: 'admin' as const,
    actor: tagActorOf(a),
    scannerId: null,
    orgId: a.orgId,
    mode: a.mode,
  };
  const g = tagGrant(ctx, 'org_mode.nfc.tag.restore', a, bindChecks(plan));
  addBind(g, ctx, plan);
  audit(g, ctx, a, 'tag.restore', id, { from: 'lost' });
  await commitTag(g);
  return shown(ctx, a, id);
}

/** A label, or none. Loaner tags are not offered, so `pool` is refused. */
export async function updateTag(
  ctx: ServiceContext,
  a: SessionTagAuthority,
  id: string,
  input: { label?: string | null | undefined; pool?: boolean | undefined },
): Promise<Tag> {
  if (input.pool)
    throw new ValidationError(
      'A loaner is a visitor tag type. Set that type instead.',
      [],
      'TAG_POOL_UNSUPPORTED',
    );
  await tagIn(ctx, a, id);
  if (input.label === undefined) return shown(ctx, a, id);
  const g = tagGrant(ctx, 'org_mode.nfc.tag.update', a);
  g.update('nfc_tags', { set: { label: input.label }, where: { id }, require: 'one' });
  audit(g, ctx, a, 'tag.update', id, { label: input.label !== null });
  await commitTag(g);
  return shown(ctx, a, id);
}
