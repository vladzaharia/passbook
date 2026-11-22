import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { commitKeyset, conflict, type KeysetView, keysetIn, keysetView } from './keysets.ts';
import { keyVersionsOf } from './repo-keysets.ts';
import { movableTags, reenrolGrant } from './repo-keysets-move.ts';
import { type KeysetAuthority, revokeKeyGrant } from './repo-keysets-write.ts';

/**
 * Cuts off one key version at once, with tags still on it: they stop verifying and must be written with a
 * newer version's keys. Only an active or retiring version; the active one leaves the keyset with none until
 * it rotates. Audited with the version and how many tags it left.
 */
export async function revokeKeyVersion(
  ctx: ServiceContext,
  a: KeysetAuthority,
  id: string,
  version: number,
): Promise<KeysetView> {
  await keysetIn(ctx, a, id);
  const found = ((await keyVersionsOf(ctx.env.DB, [id])).get(id) ?? []).find(
    (v) => v.version === version,
  );
  if (!found) throw new NotFoundError('Key version not found.', 'KEYSET_KEY_NOT_FOUND');
  if (found.state === 'retired') return keysetView(ctx, a, id);
  await commitKeyset(revokeKeyGrant(ctx, a, id, version, found.state, found.tags), a);
  return keysetView(ctx, a, id);
}

/**
 * After a leak: the tags of one keyset, those without a key of their own, move to another live keyset of the
 * same org and mode. Their passes and holders stay; each works again once written with the new keyset's keys.
 * Tags with keys of their own stay where they are (their supplier keys cannot change).
 */
export async function reenrolTags(
  ctx: ServiceContext,
  a: KeysetAuthority,
  fromId: string,
  toId: string,
): Promise<{ moved: number; ownKey: number; keyset: KeysetView }> {
  const from = await keysetIn(ctx, a, fromId);
  const to = await keysetIn(ctx, a, toId);
  if (from.id === to.id) throw conflict('Pick another keyset.', 'KEYSET_REENROL_SAME');
  if (to.disabledAt !== null) throw conflict('This keyset is disabled.', 'KEYSET_DISABLED');
  if (to.perTag || from.perTag)
    throw conflict('Imported tags keep their own keys.', 'KEYSET_REENROL_OWN_KEYS');
  const active = ((await keyVersionsOf(ctx.env.DB, [to.id])).get(to.id) ?? []).find(
    (v) => v.state === 'active',
  );
  if (!active) throw conflict('Rotate the new keyset first.', 'KEYSET_NO_ACTIVE_KEY');
  const { movable, ownKey } = await movableTags(ctx.env.DB, from.id);
  if (movable === 0) return { moved: 0, ownKey, keyset: await keysetView(ctx, a, fromId) };
  const { grant, moved } = reenrolGrant(ctx, a, {
    from: from.id,
    to: to.id,
    toVersion: active.version,
    tags: movable,
  });
  const results = await commitKeyset(grant, a);
  const n = results[grant.indexOf(moved)]?.results?.length ?? 0;
  return { moved: n, ownKey, keyset: await keysetView(ctx, a, fromId) };
}
