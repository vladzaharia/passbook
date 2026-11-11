import type { AssetEntry, PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { BakedTemplate } from './baked-types.ts';
import {
  type AssetDigest,
  ReleaseContentError,
  type ReleaseVersionContent,
  templateContentDigest,
  templateContentHash,
} from './release-content.ts';
import {
  type TemplateVersionExtra,
  type VersionExtrasSnapshot,
  versionExtrasHash,
} from './repo-preview-extras.ts';
import type { BakedVersionSnapshot } from './repo-sync.ts';
import { getVersionHashes } from './repo-version-hashes.ts';
import { copyBakedAsset, copyBakedExtra } from './sync-assets.ts';

export function bakedR2Key(slug: string, version: string, name: string): string {
  return `templates/baked/${slug}/${version}/${name}`;
}

/** Separate namespace and escaped identity segments prevent collisions with pass assets. */
export function bakedExtraR2Key(templateId: string, version: string, name: string): string {
  return `templates/baked-extras/${encodeURIComponent(templateId)}/${encodeURIComponent(version)}/${encodeURIComponent(name)}`;
}

function storedContent(version: BakedVersionSnapshot): ReleaseVersionContent {
  return {
    manifest: JSON.parse(version.manifest) as TemplateManifest,
    passJson: JSON.parse(version.pass_json) as PassJson,
    assets: JSON.parse(version.assets) as AssetEntry[],
  };
}

export interface PreparedContent {
  contentHash: string;
  assetHashes: AssetDigest[];
  extras: TemplateVersionExtra[];
  extrasHash: string;
}

export async function releaseContent(
  ctx: ServiceContext,
  t: BakedTemplate,
  existing: BakedVersionSnapshot | null,
  assets: AssetEntry[],
  snapshot: VersionExtrasSnapshot,
): Promise<PreparedContent> {
  if (!ctx.env.ASSETS && (t.assets.length > 0 || t.extras.length > 0))
    throw new ReleaseContentError('Baked static assets are unavailable.');
  for (const asset of t.assets)
    await copyBakedAsset(ctx, asset, bakedR2Key(t.slug, t.version, asset.name));
  const extras: TemplateVersionExtra[] = [];
  const names = new Set<string>();
  for (const extra of t.extras) {
    if (names.has(extra.name))
      throw new ReleaseContentError(`Duplicate template extra: ${extra.name}`);
    names.add(extra.name);
    extras.push(await copyBakedExtra(ctx, extra, bakedExtraR2Key(t.id, t.version, extra.name)));
  }
  const extrasHash = await versionExtrasHash(extras);
  const conflict = () =>
    new ConflictError(
      `Baked version conflicts with its stored content: ${t.id}`,
      'TEMPLATE_VERSION_CONTENT_CONFLICT',
    );
  if (snapshot.seal !== null) {
    if (
      snapshot.seal !== (await versionExtrasHash(snapshot.extras)) ||
      snapshot.seal !== extrasHash
    )
      throw conflict();
  } else {
    const expected = new Map(extras.map((extra) => [extra.name, extra]));
    for (const saved of snapshot.extras) {
      const extra = expected.get(saved.name);
      if (
        !extra ||
        saved.size !== extra.size ||
        saved.sha1 !== extra.sha1 ||
        saved.sha256 !== extra.sha256 ||
        saved.r2Key !== extra.r2Key
      )
        throw conflict();
    }
  }
  // Hash the exact immutable copies, not the source bundle or only its declared hashes.
  const { hash: contentHash, assetHashes } = await templateContentDigest(
    ctx,
    { manifest: t.manifest, passJson: t.passJson, assets },
    extras,
  );
  if (existing && (await templateContentHash(ctx, storedContent(existing), extras)) !== contentHash)
    throw conflict();
  const saved = await getVersionHashes(ctx.env.DB, t.id, t.version);
  if (saved && saved.contentHash !== contentHash) throw conflict();
  return { contentHash, assetHashes, extras, extrasHash };
}
