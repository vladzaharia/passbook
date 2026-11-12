import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import type { Pass } from './repo.ts';
import { tenantPassAuthorityValid } from './repo-authority.ts';
import { type AssetRow, replaceAssetIfCurrent } from './repo-history-assets.ts';
import { replaceAssetGranted } from './repo-history-assets-grant.ts';
import {
  cancelPassImageUpload,
  capturePassImageGeneration,
  type ImageMutationResult,
  passImageWriteCurrent,
  reservePassImageUpload,
} from './repo-history-image.ts';
import { isPassAssetKeyAvailable } from './repo-pass-asset-references.ts';
import { retireUnusedPassAssetKey } from './repo-transfer-asset-gc.ts';
import { sweepOneTransferAssetGc } from './transfer-asset-gc.ts';

export async function stageAsset(
  ctx: ServiceContext,
  state: ImageWriteState,
  name: string,
  next: AssetRow | null,
  previous: AssetRow | null,
  authority?: TenantPassWrite,
  uploadKey?: string,
): Promise<ImageMutationResult> {
  const result = authority
    ? await replaceAssetGranted(ctx, name, next, previous, {
        pass: state.pass,
        imageGeneration: state.imageGeneration,
        authority,
        ...(uploadKey === undefined ? {} : { uploadKey }),
      })
    : await replaceAssetIfCurrent(ctx.env.DB, state.pass.id, name, next, previous, {
        pass: state.pass,
        imageGeneration: state.imageGeneration,
        now: ctx.clock.now(),
        uploadKey,
      });
  if (result.saved) return result;
  return imageWriteConflict(ctx, state.pass, authority);
}

export interface ImageWriteState {
  pass: Pass;
  imageGeneration: number;
}

async function imageWriteConflict(
  ctx: ServiceContext,
  pass: Pass,
  authority?: TenantPassWrite,
): Promise<never> {
  if (
    authority &&
    (authority.orgId !== pass.orgId ||
      authority.mode !== pass.mode ||
      (authority.kind === 'session'
        ? authority.capability !== 'passes:operate'
        : authority.scope !== 'passes:write') ||
      !(await tenantPassAuthorityValid(ctx.env.DB, authority, ctx.clock.now())))
  )
    throw new ForbiddenError();
  throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
}

export async function captureImageWriteState(
  ctx: ServiceContext,
  pass: Pass,
  authority?: TenantPassWrite,
): Promise<ImageWriteState> {
  const imageGeneration = await capturePassImageGeneration(
    ctx.env.DB,
    pass,
    ctx.clock.now(),
    authority,
  );
  if (imageGeneration === null) return imageWriteConflict(ctx, pass, authority);
  return { pass, imageGeneration };
}

export async function assertImageWriteCurrent(
  ctx: ServiceContext,
  state: ImageWriteState,
  authority?: TenantPassWrite,
): Promise<void> {
  if (
    await passImageWriteCurrent(
      ctx.env.DB,
      state.pass,
      ctx.clock.now(),
      authority,
      state.imageGeneration,
    )
  )
    return;
  return imageWriteConflict(ctx, state.pass, authority);
}

export function advanceImageWrite(
  state: ImageWriteState,
  result: ImageMutationResult,
): ImageWriteState {
  if (!result.saved || result.imageGeneration === null)
    throw new Error('Image mutation did not commit.');
  return {
    pass: { ...state.pass, linkGeneration: state.pass.linkGeneration + 1 },
    imageGeneration: result.imageGeneration,
  };
}

/** Retirement and its no-new-reference guard are committed before the GC may touch R2. */
export async function retirePassImageObject(
  ctx: ServiceContext,
  key: string,
  passId: string,
  candidateId?: number | null,
): Promise<void> {
  const released = await retireUnusedPassAssetKey(ctx.env.DB, {
    key,
    passId,
    now: ctx.clock.now(),
    ...(candidateId == null ? {} : { candidateId }),
  });
  if (candidateId != null && !released)
    throw new ConflictError('The pass or image changed. Reload and retry.', 'PASS_CONFLICT');
  await sweepOneTransferAssetGc(ctx, key);
}

export async function retireAfterFailure(
  ctx: ServiceContext,
  key: string,
  passId: string,
  candidateId?: number | null,
): Promise<void> {
  try {
    await retirePassImageObject(ctx, key, passId, candidateId);
  } catch (error) {
    ctx.log.warn('pass.image_cleanup_failed', { code: 'PASS_IMAGE_CLEANUP_FAILED', error });
  }
}

/**
 * A fresh, unreferenced key and a conditional PUT prevent overwriting another upload. A failed
 * PUT can still have reached R2, so retire that key unless R2 explicitly rejected the condition.
 */
export async function putPassImageObject(
  ctx: ServiceContext,
  state: ImageWriteState,
  key: string,
  bytes: Uint8Array,
  authority?: TenantPassWrite,
): Promise<void> {
  await assertImageWriteCurrent(ctx, state, authority);
  if (!(await isPassAssetKeyAvailable(ctx.env.DB, key)))
    throw new ConflictError('The image changed. Reload and retry.', 'PASS_CONFLICT');
  try {
    if (
      !(await reservePassImageUpload(
        ctx.env.DB,
        state.pass,
        key,
        state.imageGeneration,
        ctx.clock.now(),
        authority,
      ))
    )
      return imageWriteConflict(ctx, state.pass, authority);
  } catch (error) {
    if (error instanceof Error && error.message.includes('image upload key unavailable'))
      throw new ConflictError('The image changed. Reload and retry.', 'PASS_CONFLICT');
    throw error;
  }
  let possiblyWritten = true;
  try {
    const stored = await ctx.env.BUCKET.put(key, bytes, {
      httpMetadata: { contentType: 'image/png' },
      onlyIf: new Headers({ 'If-None-Match': '*' }),
    });
    if (!stored) {
      possiblyWritten = false;
      await cancelPassImageUpload(ctx.env.DB, state.pass.id, key);
      throw new ConflictError('The image changed. Reload and retry.', 'PASS_CONFLICT');
    }
    await assertImageWriteCurrent(ctx, state, authority);
  } catch (error) {
    if (possiblyWritten) await retireAfterFailure(ctx, key, state.pass.id);
    throw error;
  }
}
