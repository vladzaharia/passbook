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
import {
  activeBinding,
  bindingTarget,
  lastEndedBinding,
  passFacts,
  tagTarget,
  tagView,
} from './repo-tags.ts';
import {
  addBind,
  bindChecks,
  endBinding,
  type TagAuthority,
  type TagPurpose,
  tagGrant,
} from './repo-tags-write.ts';
import { commitTag } from './tags.ts';

/** The captured console session holds passes:operate for this org. */
export function tagAuthorityOf(authority: TenantPassWrite): TagAuthority {
  if (authority.kind !== 'session' || authority.capability !== 'passes:operate')
    throw new ForbiddenError();
  return { ...authority, capability: 'passes:operate' };
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
    actorType: 'user',
    actorId: a.userId,
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
  endBinding(g, binding, 'admin', { type: 'user', id: a.userId }, ctx.clock.now());
  audit(g, ctx, a, 'tag.unbind', binding.tagId, { cause: 'admin', scope: binding.scope });
  await commitTag(g);
  return shown(ctx, a, binding.tagId);
}

/** The tag is lost: its binding ends with that cause, and a read answers "reported lost" until it is restored. */
export async function reportTagLost(
  ctx: ServiceContext,
  a: TagAuthority,
  id: string,
): Promise<Tag> {
  const tag = await tagIn(ctx, a, id);
  const active = await activeBinding(ctx.env.DB, tag.id);
  if (!active) {
    if ((await lastEndedBinding(ctx.env.DB, tag.id))?.endCause === 'lost') return shown(ctx, a, id);
    throw new ConflictError('The tag is not assigned.', 'TAG_NOT_ASSIGNED');
  }
  const g = tagGrant(ctx, 'org_mode.nfc.tag.lost', a);
  endBinding(g, active, 'lost', { type: 'user', id: a.userId }, ctx.clock.now());
  audit(g, ctx, a, 'tag.lost', tag.id, { scope: active.scope });
  await commitTag(g);
  return shown(ctx, a, id);
}

/** The tag stops opening anything and cannot be bound until restored. Nothing is tombstoned: only this row changes. */
export async function retireTag(ctx: ServiceContext, a: TagAuthority, id: string): Promise<Tag> {
  const tag = await tagIn(ctx, a, id);
  if (tag.status === 'retired') return shown(ctx, a, id);
  const g = tagGrant(ctx, 'org_mode.nfc.tag.retire', a, [
    exactlyOne('nfc_tags', { id, status: 'active' }),
  ]);
  const active = await activeBinding(ctx.env.DB, id);
  const now = ctx.clock.now();
  if (active) endBinding(g, active, 'tag_retired', { type: 'user', id: a.userId }, now);
  g.update('nfc_tags', {
    set: { status: 'retired', status_at: now },
    where: { id, status: 'active' },
  });
  audit(g, ctx, a, 'tag.retire', id, active ? { scope: active.scope } : {});
  await commitTag(g);
  return shown(ctx, a, id);
}

/**
 * A retired tag becomes active again, unassigned. A lost tag works with what it was bound to again, if
 * that is still the same holder.
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
  const last = await lastEndedBinding(ctx.env.DB, id);
  if (last?.endCause !== 'lost' || (await activeBinding(ctx.env.DB, id))) return shown(ctx, a, id);
  const pass = await passFacts(ctx.env.DB, last.passId);
  const holderBack =
    pass?.orgId === a.orgId &&
    pass.mode === a.mode &&
    pass.deletedAt === null &&
    (last.scope === 'pass' || pass.ownerUserId === last.userId);
  if (!pass || !holderBack)
    throw new ConflictError('The pass changed hands. Start again.', 'TAG_HOLDER_CHANGED');
  const plan = {
    tagId: id,
    newTag: null,
    bindingId: ctx.ids.id(),
    passId: pass.id,
    scope: last.scope,
    userId: last.userId,
    end: null,
    source: 'admin' as const,
    actor: { type: 'user' as const, id: a.userId },
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
  a: TagAuthority,
  id: string,
  input: { label?: string | null | undefined; pool?: boolean | undefined },
): Promise<Tag> {
  if (input.pool)
    throw new ValidationError('Loaner tags are not available.', [], 'TAG_POOL_UNSUPPORTED');
  await tagIn(ctx, a, id);
  if (input.label === undefined) return shown(ctx, a, id);
  const purpose: TagPurpose = 'org_mode.nfc.tag.update';
  const g = tagGrant(ctx, purpose, a);
  g.update('nfc_tags', { set: { label: input.label }, where: { id }, require: 'one' });
  await commitTag(g);
  return shown(ctx, a, id);
}
