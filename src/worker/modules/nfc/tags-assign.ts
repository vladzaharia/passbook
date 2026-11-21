import type { z } from 'zod';
import type { AssignTagSchema } from '../../../shared/contracts/nfc-tag-admin.ts';
import type { Tag } from '../../../shared/contracts/nfc-tags.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertBindable } from './pass-state.ts';
import { activeBinding, passFacts } from './repo-tag-bindings.ts';
import { tagTarget } from './repo-tags.ts';
import type { TagAuthority } from './repo-tags-write.ts';
import { normalizeTagId } from './tag-ref.ts';
import { bindTag } from './tags.ts';
import { place } from './tags-rebind.ts';

const FORMAT = { hex: 'hex', reversed: 'hex-reversed', decimal: 'decimal' } as const;

/** An admin assigns a typed tag ID or a spare tag to a pass, or to the pass's person. */
export async function assignTag(
  ctx: ServiceContext,
  a: TagAuthority,
  passId: string,
  req: z.infer<typeof AssignTagSchema>,
): Promise<Tag> {
  if ('id' in req) {
    const uid = normalizeTagId(req.id, FORMAT[req.format ?? 'hex']);
    if (!uid) throw new ValidationError('A tag ID has 4, 7 or 10 bytes.', [], 'TAG_ID_INVALID');
    return (await bindTag(ctx, a, { uid, passId, scope: req.binding, label: req.label })).tag;
  }
  const pass = await passFacts(ctx.env.DB, passId);
  if (!pass || pass.orgId !== a.orgId || pass.mode !== a.mode || pass.deletedAt !== null)
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  await assertBindable(ctx, a.orgId, passId);
  const tag = await tagTarget(ctx.env.DB, req.tagId);
  if (!tag || tag.orgId !== a.orgId || tag.mode !== a.mode)
    throw new NotFoundError('Tag not found.', 'TAG_NOT_FOUND');
  if (await activeBinding(ctx.env.DB, tag.id))
    throw new ConflictError('This tag is already assigned.', 'TAG_ALREADY_ASSIGNED');
  return place(ctx, a, tag.id, pass, req.binding, null);
}
