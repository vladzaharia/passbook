import type { AssetEntry, PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { canonicalJson, crc32, sha1Hex } from './package/hash.ts';
import type { TemplateVersionExtra } from './repo-preview-extras.ts';

export const APPLE_ADAPTER_REVISION = 1;
export const APPLE_ADAPTER_CAPABILITIES = ['apple-passkit'] as const;
export const AUDIENCE_POLICY_REVISION = 1;

export class ReleaseContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseContentError';
  }
}

export interface ReleaseVersionContent {
  manifest: TemplateManifest;
  passJson: PassJson | Record<string, unknown>;
  assets: readonly AssetEntry[];
}

async function readStaticAsset(
  ctx: ServiceContext,
  path: string,
  name: string,
): Promise<Uint8Array> {
  if (!ctx.env.ASSETS) throw new ReleaseContentError(`Template asset unavailable: ${name}`);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//'))
    throw new ReleaseContentError(`Template asset source is malformed: ${name}`);
  const base = new URL(ctx.env.PUBLIC_BASE_URL);
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    throw new ReleaseContentError(`Template asset source is malformed: ${name}`);
  }
  if (url.origin !== base.origin)
    throw new ReleaseContentError(`Template asset source is malformed: ${name}`);
  const response = await ctx.env.ASSETS.fetch(new Request(url));
  if (response.status === 404) throw new ReleaseContentError(`Template asset missing: ${name}`);
  if (!response.ok) throw new Error(`Template asset service returned HTTP ${response.status}`);
  if (response.headers.get('content-type')?.startsWith('text/html'))
    throw new ReleaseContentError(`Template asset missing: ${name}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Read and verify the bytes that a version actually references. */
export async function readReleaseAsset(
  ctx: ServiceContext,
  asset: AssetEntry,
): Promise<Uint8Array> {
  if (
    !asset ||
    typeof asset.name !== 'string' ||
    !asset.name ||
    typeof asset.slot !== 'string' ||
    !asset.slot ||
    ![1, 2, 3].includes(asset.scale) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 0 ||
    typeof asset.sha1 !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(asset.sha1) ||
    !Number.isInteger(asset.crc32) ||
    asset.crc32 < 0 ||
    asset.crc32 > 0xffffffff ||
    (asset.locale !== undefined && typeof asset.locale !== 'string') ||
    (asset.width !== undefined && (!Number.isSafeInteger(asset.width) || asset.width < 0)) ||
    (asset.height !== undefined && (!Number.isSafeInteger(asset.height) || asset.height < 0)) ||
    !asset.source ||
    typeof asset.source !== 'object'
  )
    throw new ReleaseContentError('Template asset metadata is malformed.');
  let bytes: Uint8Array;
  if (asset.source.kind === 'r2') {
    if (typeof asset.source.key !== 'string' || !asset.source.key)
      throw new ReleaseContentError(`Template asset source is malformed: ${asset.name}`);
    const object = await ctx.env.BUCKET.get(asset.source.key);
    if (!object) throw new ReleaseContentError(`Template asset missing: ${asset.name}`);
    bytes = new Uint8Array(await object.arrayBuffer());
  } else if (asset.source.kind === 'static') {
    bytes = await readStaticAsset(ctx, asset.source.path, asset.name);
  } else {
    throw new ReleaseContentError(`Template asset has no readable source: ${asset.name}`);
  }
  if (
    bytes.length !== asset.size ||
    (await sha1Hex(bytes)) !== asset.sha1.toLowerCase() ||
    crc32(bytes) !== asset.crc32
  )
    throw new ReleaseContentError(`Template asset hash mismatch: ${asset.name}`);
  return bytes;
}

/** Verify a generated extra before copying it to immutable version storage. */
export async function readGeneratedExtra(
  ctx: ServiceContext,
  extra: { name: string; size: number; sha1: string; path: string },
): Promise<Uint8Array> {
  if (
    !extra ||
    typeof extra.name !== 'string' ||
    !extra.name ||
    !Number.isSafeInteger(extra.size) ||
    extra.size < 0 ||
    typeof extra.sha1 !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(extra.sha1)
  )
    throw new ReleaseContentError('Template extra metadata is malformed.');
  const bytes = await readStaticAsset(ctx, extra.path, extra.name);
  if (bytes.length !== extra.size || (await sha1Hex(bytes)) !== extra.sha1.toLowerCase())
    throw new ReleaseContentError(`Template extra hash mismatch: ${extra.name}`);
  return bytes;
}

/** Never serve or hash an extra without verifying its immutable metadata and actual bytes. */
export async function readReleaseExtra(
  ctx: ServiceContext,
  extra: TemplateVersionExtra,
): Promise<Uint8Array> {
  if (
    !extra ||
    typeof extra.name !== 'string' ||
    !extra.name ||
    !Number.isSafeInteger(extra.size) ||
    extra.size < 0 ||
    typeof extra.sha1 !== 'string' ||
    !/^[0-9a-f]{40}$/.test(extra.sha1) ||
    typeof extra.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(extra.sha256) ||
    typeof extra.r2Key !== 'string' ||
    !extra.r2Key
  )
    throw new ReleaseContentError('Template extra metadata is malformed.');
  const object = await ctx.env.BUCKET.get(extra.r2Key);
  if (!object) throw new ReleaseContentError(`Template extra missing: ${extra.name}`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (
    bytes.length !== extra.size ||
    (await sha1Hex(bytes)) !== extra.sha1 ||
    (await sha256Hex(bytes)) !== extra.sha256
  )
    throw new ReleaseContentError(`Template extra hash mismatch: ${extra.name}`);
  return bytes;
}

export interface AssetDigest {
  name: string;
  sha256: string;
}

/**
 * Bind the complete documents, metadata and SHA-256 of every actual asset and extra. With `stored`
 * (the per-asset digests saved at candidate creation) no asset or extra bytes are read: that is the
 * issuance check, which proves the saved rows still produce the released hash.
 */
export async function templateContentDigest(
  ctx: ServiceContext,
  version: ReleaseVersionContent,
  extras: readonly TemplateVersionExtra[] = [],
  stored?: readonly AssetDigest[],
): Promise<{ hash: string; assetHashes: AssetDigest[] }> {
  if (!Array.isArray(version.assets) || !Array.isArray(extras))
    throw new ReleaseContentError('Template assets are malformed.');
  if (stored && stored.length !== version.assets.length)
    throw new ReleaseContentError('Template asset digests do not match the version.');
  const assets = [];
  const assetHashes: AssetDigest[] = [];
  const names = new Set<string>();
  for (const [index, asset] of version.assets.entries()) {
    const known = stored?.[index];
    if (known && known.name !== asset.name)
      throw new ReleaseContentError('Template asset digests do not match the version.');
    const sha256 = known ? known.sha256 : await sha256Hex(await readReleaseAsset(ctx, asset));
    const { source: _source, ...metadata } = asset;
    assets.push({ ...metadata, sha256 });
    assetHashes.push({ name: asset.name, sha256 });
    names.add(asset.name);
  }
  assets.sort((a, b) => {
    const left = canonicalJson(a);
    const right = canonicalJson(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const extraNames = new Set<string>();
  const extraContent = [];
  for (const extra of extras) {
    if (!stored) await readReleaseExtra(ctx, extra);
    if (extraNames.has(extra.name))
      throw new ReleaseContentError(`Duplicate template extra: ${extra.name}`);
    extraNames.add(extra.name);
    names.add(extra.name);
    extraContent.push({
      name: extra.name,
      size: extra.size,
      sha1: extra.sha1,
      sha256: extra.sha256,
    });
  }
  const previewOnly = version.manifest?.previewOnlyAssets;
  if (previewOnly !== undefined) {
    if (!Array.isArray(previewOnly))
      throw new ReleaseContentError('Template preview assets are malformed.');
    for (const name of previewOnly) {
      if (typeof name !== 'string' || !name || !names.has(name))
        throw new ReleaseContentError(`Template preview asset missing: ${String(name)}`);
    }
  }
  if (extraContent.length === 0)
    return {
      hash: await sha256Hex(
        canonicalJson({ manifest: version.manifest, passJson: version.passJson, assets }),
      ),
      assetHashes,
    };
  extraContent.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    hash: await sha256Hex(
      canonicalJson({
        manifest: version.manifest,
        passJson: version.passJson,
        assets,
        extras: extraContent,
      }),
    ),
    assetHashes,
  };
}

export async function templateContentHash(
  ctx: ServiceContext,
  version: ReleaseVersionContent,
  extras: readonly TemplateVersionExtra[] = [],
): Promise<string> {
  return (await templateContentDigest(ctx, version, extras)).hash;
}

export function candidateHash(snapshot: unknown): Promise<string> {
  return sha256Hex(canonicalJson(snapshot));
}
