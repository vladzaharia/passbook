import type { Tag } from '../../../shared/contracts/nfc-tags.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { candidateById } from '../scan/repo-lookup.ts';
import { tagFit } from '../scan/tag-assurance.ts';
import { candidateTypeFit, typeFacts } from './policy.ts';
import { getTagType, passTypeCount } from './repo-tag-types.ts';
import { listTags, type TagListFilter } from './repo-tags.ts';

/**
 * One page of spare tags that `passId`'s policy takes as a `scope` binding: the type fits the pass's template
 * and use, allows that scope, has room on the pass, and the tag's assurance meets the template's. It checks
 * what `bindPolicy` checks at assign, so a listed tag is one the assign will take.
 */
export async function listSparesFor(
  ctx: ServiceContext,
  filter: TagListFilter,
  passId: string,
  scope: 'pass' | 'user',
): Promise<{ items: Tag[]; nextCursor: string | null }> {
  const candidate = await candidateById(ctx.env.DB, filter.orgId, passId);
  if (!candidate || candidate.pass.mode !== filter.mode) return { items: [], nextCursor: null };
  const types = new Map<string, Awaited<ReturnType<typeof getTagType>>>();
  const items: Tag[] = [];
  let cursor = filter.cursor;
  for (;;) {
    const page = await listTags(ctx.env.DB, { ...filter, cursor });
    for (const tag of page.items) {
      let type = null;
      if (tag.type) {
        if (!types.has(tag.type.id))
          types.set(tag.type.id, await getTagType(ctx.env.DB, filter.orgId, tag.type.id));
        type = types.get(tag.type.id) ?? null;
        if (!type) continue;
      }
      if (candidateTypeFit(candidate, type ? typeFacts(type) : null) !== 'ok') continue;
      if (tagFit(ctx, candidate, tag.assurance) !== 'ok') continue;
      if (type && type.scopes !== 'both' && type.scopes !== scope) continue;
      if (
        type &&
        scope === 'pass' &&
        (await passTypeCount(ctx.env.DB, passId, type.id, null, ctx.clock.now())) >= type.perPass
      )
        continue;
      items.push(tag);
      if (items.length === filter.limit) return { items, nextCursor: tag.id };
    }
    if (!page.nextCursor) return { items, nextCursor: null };
    cursor = page.nextCursor;
  }
}
