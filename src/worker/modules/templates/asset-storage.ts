import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

/** Create a version asset once, accepting a concurrent or repeated write only for identical bytes. */
export async function putVersionAsset(
  ctx: ServiceContext,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  const written = await ctx.env.BUCKET.put(key, bytes, {
    onlyIf: new Headers({ 'If-None-Match': '*' }),
  });
  const existing = await ctx.env.BUCKET.get(key);
  if (!existing)
    throw new ConflictError(
      written
        ? 'The stored template version asset is missing after creation.'
        : 'The existing template version asset is missing after a write conflict.',
      'TEMPLATE_ASSET_CONFLICT',
    );
  const stored = new Uint8Array(await existing.arrayBuffer());
  if (stored.length !== bytes.length || stored.some((value, index) => value !== bytes[index]))
    throw new ConflictError(
      'The existing template version asset has different content.',
      'TEMPLATE_ASSET_CONFLICT',
    );
}
