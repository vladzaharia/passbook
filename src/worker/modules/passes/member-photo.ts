import { crc32 } from '../../../passkit/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  assertImageWriteCurrent,
  captureImageWriteState,
  putPassImageObject,
} from './asset-service-image-write.ts';
import { validateAsset } from './assets.ts';
import type { TenantPassWrite } from './http.ts';
import { memberPhotoPixels } from './member-photo-bytes.ts';
import { memberPhotoDto, memberPhotoWalletSupported } from './member-photo-service-metadata.ts';
import { saveMemberPhoto } from './member-photo-service-save.ts';
import { getPassForWrite } from './pass-access.ts';
import type { Pass } from './repo.ts';
import { type MemberPhotoRow, memberPhoto } from './repo-member-photo.ts';
import { getPass } from './repo-read-pass.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';

const missing = () => new NotFoundError('Member photo not found.', 'MEMBER_PHOTO_NOT_FOUND');

async function readable(ctx: ServiceContext, passId: string, scope: ScopeArg) {
  const pass = await getPass(ctx.env.DB, passId, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return pass;
}

export async function getMemberPhoto(ctx: ServiceContext, passId: string, scope: ScopeArg) {
  const pass = await readable(ctx, passId, scope);
  return memberPhotoDto(ctx, pass, await memberPhoto(ctx.env.DB, pass.orgId, passId));
}

export async function openMemberPhotoFromSnapshot(
  ctx: ServiceContext,
  row: Pick<MemberPhotoRow, 'r2_key' | 'version'>,
) {
  const object = await ctx.env.BUCKET.get(row.r2_key);
  if (!object) throw missing();
  return new Response(object.body, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      etag: `"${row.version}"`,
    },
  });
}

export async function openMemberPhoto(ctx: ServiceContext, orgId: string, passId: string) {
  const row = await memberPhoto(ctx.env.DB, orgId, passId);
  if (!row) throw missing();
  return openMemberPhotoFromSnapshot(ctx, row);
}

export async function readMemberPhoto(ctx: ServiceContext, passId: string, scope: ScopeArg) {
  const pass = await readable(ctx, passId, scope);
  return openMemberPhoto(ctx, pass.orgId, passId);
}

async function allowWallet(ctx: ServiceContext, pass: Pass, include: boolean) {
  if (include && !(await memberPhotoWalletSupported(ctx, pass)))
    throw new ValidationError(
      'Use a generic or event ticket pass without a strip image for a member photo.',
      [],
      'MEMBER_PHOTO_STYLE',
    );
}

export async function putMemberPhoto(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  input: { png: string; includeInPass: boolean },
  scope: ScopeArg,
  authority?: TenantPassWrite,
) {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  const state = await captureImageWriteState(ctx, pass, authority);
  await allowWallet(ctx, pass, input.includeInPass);
  await assertImageWriteCurrent(ctx, state, authority);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.png))
    throw new ValidationError('Choose a valid photo and try again.', [], 'MEMBER_PHOTO_ENCODING');
  const original = Uint8Array.from(atob(input.png), (c) => c.charCodeAt(0));
  const info = validateAsset('thumbnail@3x.png', original);
  const bytes = memberPhotoPixels(original);
  if (info.width !== 270 || info.height !== 270)
    throw new ValidationError(
      'Crop the photo to a 270 × 270 pixel square.',
      [],
      'MEMBER_PHOTO_DIMENSIONS',
    );
  const previous = await memberPhoto(ctx.env.DB, pass.orgId, passId);
  const sha1 = await sha1Hex(bytes);
  const next: MemberPhotoRow = {
    pass_id: passId,
    org_id: pass.orgId,
    r2_key: `member-photos/${pass.orgId}/${passId}/${ctx.ids.token(32)}-${sha1}.png`,
    sha1,
    size: bytes.length,
    crc32: crc32(bytes),
    include_in_pass: Number(input.includeInPass),
    version: ctx.ids.token(16),
    updated_at: ctx.clock.now(),
  };
  await putPassImageObject(ctx, state, next.r2_key, bytes, authority);
  return saveMemberPhoto(ctx, actor, state, scope, previous, next, authority);
}

export async function updateMemberPhoto(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  includeInPass: boolean,
  scope: ScopeArg,
  authority?: TenantPassWrite,
) {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  const state = await captureImageWriteState(ctx, pass, authority);
  const previous = await memberPhoto(ctx.env.DB, pass.orgId, passId);
  if (!previous) throw missing();
  await allowWallet(ctx, pass, includeInPass);
  await assertImageWriteCurrent(ctx, state, authority);
  return saveMemberPhoto(
    ctx,
    actor,
    state,
    scope,
    previous,
    {
      ...previous,
      include_in_pass: Number(includeInPass),
      version: ctx.ids.token(16),
      updated_at: ctx.clock.now(),
    },
    authority,
  );
}

export async function deleteMemberPhoto(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: ScopeArg,
  authority?: TenantPassWrite,
) {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  const state = await captureImageWriteState(ctx, pass, authority);
  const previous = await memberPhoto(ctx.env.DB, pass.orgId, passId);
  if (!previous) throw missing();
  return saveMemberPhoto(ctx, actor, state, scope, previous, null, authority);
}
