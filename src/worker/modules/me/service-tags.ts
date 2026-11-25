import { grant } from '../../platform/authority.ts';
import { exactlyOne } from '../../platform/authority-checks.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { grantedAudit } from '../audit/repo-granted.ts';
import { activeBinding, type BindingRow, lostBinding } from '../nfc/repo-tag-bindings.ts';
import { getTagType } from '../nfc/repo-tag-types.ts';
import { tagTarget } from '../nfc/repo-tags.ts';
import { commitTag } from '../nfc/tags.ts';

const notFound = () => new NotFoundError('Tag not found.', 'TAG_NOT_FOUND');
const CODES = { lineage: 'TAG_HOLDER_CHANGED', stale: 'TAG_HOLDER_CHANGED' } as const;

/** The holder's own: a pass binding on a pass they own, or a user binding made for them. */
const ownedBy = (b: BindingRow, userId: string) =>
  b.passOwnerId === userId && (b.scope === 'pass' ? true : b.userId === userId);

/**
 * The holder reports a tag lost. A pass binding ends through the grant of its pass, a user binding through
 * the grant of its anchor pass, which the holder always owns. Only an admin restores it.
 */
export async function reportMyTagLost(
  ctx: ServiceContext,
  userId: string,
  sessionId: string,
  tagId: string,
): Promise<{ ok: true }> {
  await enforceRateLimit(ctx.env, 'RL_REFRESH', `tag-lost:${userId}`);
  const tag = await tagTarget(ctx.env.DB, tagId);
  if (!tag) throw notFound();
  const binding = await activeBinding(ctx.env.DB, tagId);
  if (!binding) {
    const last = tag.lostAt === null ? null : await lostBinding(ctx.env.DB, tagId);
    // A retry after the report went through.
    if (last && ownedBy(last, userId) && (last.scope === 'user' || last.holderOwner === userId))
      return { ok: true };
    throw notFound();
  }
  if (!ownedBy(binding, userId) || tag.status !== 'active') throw notFound();
  // A loaner belongs to the desk: the holder cannot report it lost, only hand it back.
  const type = tag.typeId ? await getTagType(ctx.env.DB, tag.orgId, tag.typeId) : null;
  if (type?.use === 'visitor')
    throw new ConflictError('This tag belongs to the desk. Hand it back there.', 'TAG_LENT');
  const g = grant(ctx, {
    purpose: 'org_mode.nfc.tag.holder_lost',
    principal: {
      kind: 'holder',
      passId: binding.passId,
      proof: { via: 'session', userId, sessionIdHash: sessionId },
    },
    checks: [exactlyOne('nfc_tags', { id: tagId, lost_at: null })],
    codes: CODES,
    tables: ['tag_bindings'],
  });
  // Through the pass edge: the holder grant is pinned to a pass, and the tag row is marked by trigger 0097.
  g.joined('tag_bindings', {
    via: 'pass_id',
    where: { id: binding.id, ended_at: null },
    set: {
      ended_at: ctx.clock.now(),
      ended_by_type: 'user',
      ended_by: userId,
      end_cause: 'lost',
    },
    require: 'one',
    returning: ['id'],
  });
  grantedAudit(g, ctx, {
    orgId: tag.orgId,
    actorType: 'user',
    actorId: userId,
    action: 'tag.lost',
    targetType: 'tag',
    targetId: tagId,
    detail: { scope: binding.scope, by: 'holder' },
  });
  await commitTag(g);
  return { ok: true };
}
