import { ConflictError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { BakedAsset, BakedTemplate } from './baked-types.ts';
import { ReleaseContentError, readGeneratedExtra, readReleaseAsset } from './release-content.ts';
import type { TemplateVersionExtra } from './repo-preview-extras.ts';

export async function copyBakedAsset(
  ctx: ServiceContext,
  asset: BakedAsset,
  key: string,
): Promise<void> {
  const bytes = await readReleaseAsset(ctx, asset);
  if (!(await ctx.env.BUCKET.head(key))) {
    // Never overwrite an immutable copy, including when another Worker won this race.
    await ctx.env.BUCKET.put(key, bytes, { onlyIf: new Headers({ 'If-None-Match': '*' }) });
  }
  const stored = await readReleaseAsset(ctx, { ...asset, source: { kind: 'r2', key } });
  if (stored.length !== bytes.length || stored.some((value, i) => value !== bytes[i]))
    throw new ReleaseContentError(`Baked asset conflicts with its stored copy: ${asset.name}`);
}

export async function copyBakedExtra(
  ctx: ServiceContext,
  extra: BakedTemplate['extras'][number],
  key: string,
): Promise<TemplateVersionExtra> {
  const bytes = await readGeneratedExtra(ctx, extra);
  const metadata: TemplateVersionExtra = {
    name: extra.name,
    size: extra.size,
    sha1: extra.sha1.toLowerCase(),
    sha256: await sha256Hex(bytes),
    r2Key: key,
  };
  // An existing object is never replaced, even if another Worker wins this race.
  await ctx.env.BUCKET.put(metadata.r2Key, bytes, {
    onlyIf: new Headers({ 'If-None-Match': '*' }),
  });
  const object = await ctx.env.BUCKET.get(metadata.r2Key);
  if (!object) throw new ReleaseContentError(`Template extra missing: ${extra.name}`);
  const stored = new Uint8Array(await object.arrayBuffer());
  if (stored.length !== bytes.length || stored.some((value, i) => value !== bytes[i]))
    throw new ConflictError(
      `Baked extra conflicts with its stored copy: ${extra.name}`,
      'TEMPLATE_VERSION_CONTENT_CONFLICT',
    );
  return metadata;
}
