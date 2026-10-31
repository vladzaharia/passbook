import { sha1Hex } from '../../../passkit/sign/index.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { validateAsset } from './assets.ts';
import { publishPass } from './publish.ts';
import { type AssetRow, getPass, listAssets, removeAsset, upsertAsset } from './repo.ts';
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

export async function putPassAsset(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  name: string,
  bytes: Uint8Array,
  scope: string | null,
) {
  const pass = await requirePass(ctx, passId, scope);
  const info = validateAsset(name, bytes);
  const sha1 = await sha1Hex(bytes);
  const r2Key = `pass-assets/${passId}/${sha1}.png`;
  await ctx.env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: 'image/png' } });
  const row: AssetRow = {
    name,
    r2Key,
    sha1,
    size: bytes.length,
    width: info.width,
    height: info.height,
    createdAt: ctx.clock.now(),
  };
  const previous = await upsertAsset(ctx.env.DB, passId, row);
  try {
    await rebuildOrRestore(ctx, actor, passId, scope, name, previous);
  } catch (error) {
    if (previous?.r2Key !== r2Key) await ctx.env.BUCKET.delete(r2Key);
    throw error;
  }
  if (previous && previous.r2Key !== r2Key) await ctx.env.BUCKET.delete(previous.r2Key);
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'pass.asset.put',
    targetType: 'pass',
    targetId: passId,
    detail: { name },
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
  await ctx.env.BUCKET.delete(previous.r2Key);
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
