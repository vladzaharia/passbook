import { crc32 } from '../../../passkit/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { imagesFromBinding } from '../templates/images-binding.ts';
import type { ImageTools } from '../templates/package/images.ts';
import {
  advanceImageWrite,
  assertImageWriteCurrent,
  captureImageWriteState,
  type ImageWriteState,
  putPassImageObject,
  retireAfterFailure,
  retirePassImageObject,
  stageAsset,
} from './asset-service-image-write.ts';
import { parseAssetName, validateAsset } from './assets.ts';
import type { TenantPassWrite } from './http.ts';
import { getPassForWrite } from './pass-access.ts';
import { publishPass } from './publish.ts';
import { type AssetRow, listAssets, replaceAssetIfCurrent } from './repo-history-assets.ts';
import { getPass } from './repo-read-pass.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';

const toDto = (a: AssetRow) => ({
  name: a.name,
  sha1: a.sha1,
  size: a.size,
  width: a.width,
  height: a.height,
  createdAt: a.createdAt,
});

export async function listPassAssets(ctx: ServiceContext, passId: string, scope: ScopeArg) {
  if (!(await getPass(ctx.env.DB, passId, scope)))
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return { items: (await listAssets(ctx.env.DB, passId)).map(toDto) };
}

async function rebuild(
  ctx: ServiceContext,
  actor: Actor,
  state: ImageWriteState,
  scope: ScopeArg,
  authority?: TenantPassWrite,
): Promise<void> {
  const { pass } = state;
  const published = await publishPass(ctx, {
    passId: pass.id,
    orgScope: scope,
    cause: actor.type === 'api_key' ? 'api' : 'admin',
    actor,
    force: true,
    authority,
    expectedImageGeneration: state.imageGeneration,
    mutate: (current) => {
      if (
        current.orgId !== pass.orgId ||
        current.mode !== pass.mode ||
        current.version !== pass.version ||
        current.templateId !== pass.templateId ||
        current.templateVersion !== pass.templateVersion ||
        current.releaseId !== pass.releaseId ||
        current.serial !== pass.serial ||
        current.authToken !== pass.authToken ||
        current.downloadToken !== pass.downloadToken ||
        current.holderEmail !== pass.holderEmail ||
        current.ownerUserId !== pass.ownerUserId ||
        current.linkGeneration !== pass.linkGeneration ||
        current.identityId !== pass.identityId ||
        current.credentialGeneration !== pass.credentialGeneration ||
        current.lifecycleGeneration !== pass.lifecycleGeneration ||
        current.revision !== pass.revision ||
        current.status !== pass.status ||
        current.removedAt !== pass.removedAt
      )
        throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
      return {};
    },
  });
  await assertImageWriteCurrent(
    ctx,
    { pass: published.pass, imageGeneration: state.imageGeneration },
    authority,
  );
}

function hypotheticalAdvance(state: ImageWriteState): ImageWriteState {
  return {
    pass: { ...state.pass, linkGeneration: state.pass.linkGeneration + 1 },
    imageGeneration: state.imageGeneration + 1,
  };
}

async function storeRow(
  ctx: ServiceContext,
  state: ImageWriteState,
  name: string,
  bytes: Uint8Array,
  authority?: TenantPassWrite,
): Promise<AssetRow> {
  const info = validateAsset(name, bytes);
  const sha1 = await sha1Hex(bytes);
  const r2Key = `pass-assets/${state.pass.id}/${name}/${ctx.ids.token(32)}-${sha1}.png`;
  await putPassImageObject(ctx, state, r2Key, bytes, authority);
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
  state: ImageWriteState,
  name: string,
  bytes: Uint8Array,
  tools: ImageTools,
  authority?: TenantPassWrite,
): Promise<AssetRow | null> {
  const parsed = parseAssetName(name);
  if (parsed.scale !== 3) return null;
  await assertImageWriteCurrent(ctx, state, authority);
  const info = validateAsset(name, bytes);
  const target = name.replace('@3x.png', '@2x.png');
  const scaled = await tools.resize?.(
    bytes,
    Math.round((info.width * 2) / 3),
    Math.round((info.height * 2) / 3),
  );
  await assertImageWriteCurrent(ctx, state, authority);
  if (!scaled) {
    ctx.log.warn('pass.asset_derive_unavailable', {
      passId: state.pass.id,
      code: 'IMAGE_SCALE_MISSING',
    });
    return null;
  }
  return storeRow(ctx, state, target, scaled, authority);
}

export async function putPassAsset(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  name: string,
  bytes: Uint8Array,
  scope: ScopeArg,
  tools: ImageTools = imagesFromBinding(ctx.env.IMAGES, ctx.log),
  authority?: TenantPassWrite,
) {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  let state = await captureImageWriteState(ctx, pass, authority);
  const row = await storeRow(ctx, state, name, bytes, authority);
  let extra: AssetRow | null = null;
  const staged: {
    next: AssetRow;
    previous: AssetRow | null;
    candidateId: number | null;
    committed: boolean;
  }[] = [];
  const stage = async (next: AssetRow, previous: AssetRow | null) => {
    const change = { next, previous, candidateId: null as number | null, committed: false };
    staged.push(change);
    const result = await stageAsset(ctx, state, next.name, next, previous, authority, next.r2Key);
    change.candidateId = result.candidateId;
    change.committed = true;
    state = advanceImageWrite(state, result);
  };
  try {
    const existing = await listAssets(ctx.env.DB, passId);
    await stage(row, existing.find((item) => item.name === row.name) ?? null);
    const derived = await derived2x(ctx, state, name, bytes, tools, authority);
    extra = derived;
    if (derived) await stage(derived, existing.find((item) => item.name === derived.name) ?? null);
    await rebuild(ctx, actor, state, scope, authority);
  } catch (error) {
    for (const change of staged.reverse()) {
      const expected = change.committed ? state : hypotheticalAdvance(state);
      try {
        if (!change.committed && change.previous) continue;
        const restored = await replaceAssetIfCurrent(
          ctx.env.DB,
          passId,
          change.next.name,
          change.previous,
          change.next,
          {
            pass: expected.pass,
            imageGeneration: expected.imageGeneration,
            now: ctx.clock.now(),
            ...(change.candidateId === null ? {} : { candidateId: change.candidateId }),
          },
        );
        if (restored.saved) {
          state = advanceImageWrite(expected, restored);
          await retireAfterFailure(ctx, change.next.r2Key, passId, restored.candidateId);
        }
      } catch (restoreError) {
        ctx.log.warn('pass.asset_restore_failed', {
          code: 'PASS_ASSET_RESTORE_FAILED',
          error: restoreError,
        });
      }
      if (change.previous && change.candidateId !== null)
        await retireAfterFailure(ctx, change.previous.r2Key, passId, change.candidateId);
    }
    if (extra) await retireAfterFailure(ctx, extra.r2Key, passId);
    await retireAfterFailure(ctx, row.r2Key, passId);
    throw error;
  }
  for (const { previous, candidateId } of staged)
    if (previous) await retirePassImageObject(ctx, previous.r2Key, passId, candidateId);
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
  scope: ScopeArg,
  authority?: TenantPassWrite,
): Promise<void> {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  let state = await captureImageWriteState(ctx, pass, authority);
  const previous = (await listAssets(ctx.env.DB, passId)).find((a) => a.name === name);
  if (!previous) throw new NotFoundError('Image not found.', 'ASSET_NOT_FOUND');
  let candidateId: number | null;
  try {
    const result = await stageAsset(ctx, state, name, null, previous, authority);
    candidateId = result.candidateId;
    state = advanceImageWrite(state, result);
  } catch (error) {
    await retireAfterFailure(ctx, previous.r2Key, passId);
    throw error;
  }
  try {
    await rebuild(ctx, actor, state, scope, authority);
  } catch (error) {
    try {
      await replaceAssetIfCurrent(ctx.env.DB, passId, name, previous, null, {
        pass: state.pass,
        imageGeneration: state.imageGeneration,
        now: ctx.clock.now(),
        ...(candidateId === null ? {} : { candidateId }),
      });
    } catch (restoreError) {
      ctx.log.warn('pass.asset_restore_failed', {
        code: 'PASS_ASSET_RESTORE_FAILED',
        error: restoreError,
      });
    }
    await retireAfterFailure(ctx, previous.r2Key, passId, candidateId);
    throw error;
  }
  await retirePassImageObject(ctx, previous.r2Key, passId, candidateId);
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
