import { crc32 } from '../../../passkit/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { imagesFromBinding } from '../templates/images-binding.ts';
import type { ImageTools } from '../templates/package/images.ts';
import { parseAssetName, validateAsset } from './assets.ts';
import { publishPass } from './publish.ts';
import {
  type AssetRow,
  assetKeyInUse,
  getPass,
  listAssets,
  removeAsset,
  upsertAsset,
} from './repo.ts';
import type { Actor } from './service.ts';

const toDto = (a: AssetRow) => ({
  name: a.name,
  sha1: a.sha1,
  size: a.size,
  width: a.width,
  height: a.height,
  createdAt: a.createdAt,
});

async function requirePass(ctx: ServiceContext, passId: string, scope: string | null) {
  const pass = await getPass(ctx.env.DB, passId, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return pass;
}

export async function listPassAssets(ctx: ServiceContext, passId: string, scope: string | null) {
  await requirePass(ctx, passId, scope);
  return { items: (await listAssets(ctx.env.DB, passId)).map(toDto) };
}

/** Restores the previous row if the rebuild fails, so a bad image never leaves the pass unbuildable. */
async function rebuildOrRestore(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: string | null,
  name: string,
  previous: AssetRow | null,
): Promise<void> {
  try {
    await publishPass(ctx, {
      passId,
      orgScope: scope,
      cause: actor.type === 'api_key' ? 'api' : 'admin',
      actor,
      force: true,
    });
  } catch (error) {
    if (previous) await upsertAsset(ctx.env.DB, passId, previous);
    else await removeAsset(ctx.env.DB, passId, name);
    throw error;
  }
}

/** Slots with identical bytes used to share one object; delete only when no row points at it. */
async function deleteIfUnreferenced(ctx: ServiceContext, r2Key: string): Promise<void> {
  if (!(await assetKeyInUse(ctx.env.DB, r2Key))) await ctx.env.BUCKET.delete(r2Key);
}

async function storeRow(
  ctx: ServiceContext,
  passId: string,
  name: string,
  bytes: Uint8Array,
): Promise<AssetRow> {
  const info = validateAsset(name, bytes);
  const sha1 = await sha1Hex(bytes);
  const r2Key = `pass-assets/${passId}/${name}/${sha1}.png`;
  await ctx.env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: 'image/png' } });
  return {
    name,
    r2Key,
    sha1,
    size: bytes.length,
    width: info.width,
    height: info.height,
    crc32: crc32(bytes),
    createdAt: ctx.clock.now(),
  };
}

/**
 * An @3x upload alone also stores @2x, scaled by the Images binding (signed packages ship @2x and
 * @3x only). Without the binding the @3x stays alone and Wallet scales it.
 */
async function derived2x(
  ctx: ServiceContext,
  passId: string,
  name: string,
  bytes: Uint8Array,
  tools: ImageTools,
): Promise<AssetRow | null> {
  const parsed = parseAssetName(name);
  if (parsed.scale !== 3) return null;
  const info = validateAsset(name, bytes);
  const target = name.replace('@3x.png', '@2x.png');
  const scaled = await tools.resize?.(
    bytes,
    Math.round((info.width * 2) / 3),
    Math.round((info.height * 2) / 3),
  );
  if (!scaled) {
    ctx.log.warn('pass.asset_derive_unavailable', { passId, code: 'IMAGE_SCALE_MISSING' });
    return null;
  }
  return storeRow(ctx, passId, target, scaled);
}

export async function putPassAsset(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  name: string,
  bytes: Uint8Array,
  scope: string | null,
  tools: ImageTools = imagesFromBinding(ctx.env.IMAGES, ctx.log),
) {
  const pass = await requirePass(ctx, passId, scope);
  const row = await storeRow(ctx, passId, name, bytes);
  const extra = await derived2x(ctx, passId, name, bytes, tools);
  const previous = await upsertAsset(ctx.env.DB, passId, row);
  const previousExtra = extra ? await upsertAsset(ctx.env.DB, passId, extra) : null;
  try {
    await rebuildOrRestore(ctx, actor, passId, scope, name, previous);
  } catch (error) {
    if (extra) {
      if (previousExtra) await upsertAsset(ctx.env.DB, passId, previousExtra);
      else await removeAsset(ctx.env.DB, passId, extra.name);
      await deleteIfUnreferenced(ctx, extra.r2Key);
    }
    await deleteIfUnreferenced(ctx, row.r2Key);
    throw error;
  }
  for (const [old, now] of [
    [previous, row],
    [previousExtra, extra],
  ] as const)
    if (old && now && old.r2Key !== now.r2Key) await deleteIfUnreferenced(ctx, old.r2Key);
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.asset.put',
    targetType: 'pass',
    targetId: passId,
    detail: { name, ...(extra ? { derived: extra.name } : {}) },
  });
  return toDto(row);
}

export async function deletePassAsset(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  name: string,
  scope: string | null,
): Promise<void> {
  const pass = await requirePass(ctx, passId, scope);
  const previous = (await listAssets(ctx.env.DB, passId)).find((a) => a.name === name);
  if (!previous || !(await removeAsset(ctx.env.DB, passId, name)))
    throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
  await rebuildOrRestore(ctx, actor, passId, scope, name, previous);
  await deleteIfUnreferenced(ctx, previous.r2Key);
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.asset.delete',
    targetType: 'pass',
    targetId: passId,
    detail: { name },
  });
}
