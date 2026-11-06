import { crc32 } from '../../../passkit/index.ts';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { validateAsset } from './assets.ts';
import { resolveTemplate } from './builder.ts';
import { memberPhotoPixels } from './member-photo-bytes.ts';
import { getPassForWrite } from './pass-access.ts';
import { publishPass } from './publish.ts';
import { getPass, listAssets, type Pass } from './repo.ts';
import {
  type MemberPhotoRow,
  memberPhoto,
  photoKeyInUse,
  replaceMemberPhoto,
} from './repo-member-photo.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';

const missing = () => new NotFoundError('Member photo not found.', 'MEMBER_PHOTO_NOT_FOUND');

async function readable(ctx: ServiceContext, passId: string, scope: ScopeArg) {
  const pass = await getPass(ctx.env.DB, passId, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return pass;
}

async function supported(ctx: ServiceContext, pass: Pass) {
  const [template, overrides] = await Promise.all([
    resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion),
    listAssets(ctx.env.DB, pass.id),
  ]);
  return (
    'generic' in template.passJson ||
    ('eventTicket' in template.passJson &&
      !template.assets.some((a) => a.slot === 'strip') &&
      !overrides.some((a) => /^strip(?:@[23]x)?\.png$/.test(a.name)))
  );
}

async function dto(ctx: ServiceContext, pass: Pass, photo: MemberPhotoRow | null) {
  return {
    passId: pass.id,
    orgId: pass.orgId,
    url: photo ? `/api/v1/passes/${pass.id}/member-photo/image?v=${photo.version}` : null,
    includeInPass: photo?.include_in_pass === 1,
    walletSupported: await supported(ctx, pass),
    updatedAt: photo?.updated_at ?? null,
  };
}

export async function getMemberPhoto(ctx: ServiceContext, passId: string, scope: ScopeArg) {
  const pass = await readable(ctx, passId, scope);
  return dto(ctx, pass, await memberPhoto(ctx.env.DB, pass.orgId, passId));
}

export async function openMemberPhoto(ctx: ServiceContext, orgId: string, passId: string) {
  const row = await memberPhoto(ctx.env.DB, orgId, passId);
  if (!row) throw missing();
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

export async function readMemberPhoto(ctx: ServiceContext, passId: string, scope: ScopeArg) {
  const pass = await readable(ctx, passId, scope);
  return openMemberPhoto(ctx, pass.orgId, passId);
}

async function clean(ctx: ServiceContext, row: MemberPhotoRow | null) {
  if (row && !(await photoKeyInUse(ctx.env.DB, row.r2_key)))
    await ctx.env.BUCKET.delete(row.r2_key);
}

async function save(
  ctx: ServiceContext,
  actor: Actor,
  pass: Pass,
  scope: ScopeArg,
  previous: MemberPhotoRow | null,
  next: MemberPhotoRow | null,
) {
  if (
    !(await replaceMemberPhoto(ctx.env.DB, pass.orgId, pass.id, next, previous?.version ?? null))
  ) {
    await clean(ctx, next);
    throw new ConflictError('The photo changed; reload and try again.', 'MEMBER_PHOTO_CHANGED');
  }
  try {
    if (previous?.include_in_pass || next?.include_in_pass) {
      await publishPass(ctx, {
        passId: pass.id,
        orgScope: scope,
        cause: actor.type === 'api_key' ? 'api' : 'admin',
        actor,
        force: true,
      });
    }
  } catch (error) {
    const restored = await replaceMemberPhoto(
      ctx.env.DB,
      pass.orgId,
      pass.id,
      previous,
      next?.version ?? null,
    );
    if (!restored)
      ctx.log.error('pass.photo_restore_failed', {
        passId: pass.id,
        code: 'MEMBER_PHOTO_RESTORE_FAILED',
      });
    await clean(ctx, next);
    throw error;
  }
  await clean(ctx, previous);
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: next ? 'pass.photo.put' : 'pass.photo.delete',
    targetType: 'pass',
    targetId: pass.id,
    detail: { includeInPass: next?.include_in_pass === 1 },
  });
  return dto(ctx, pass, next);
}

async function allowWallet(ctx: ServiceContext, pass: Pass, include: boolean) {
  if (include && !(await supported(ctx, pass)))
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
) {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  await allowWallet(ctx, pass, input.includeInPass);
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
    r2_key: `member-photos/${pass.orgId}/${passId}/${sha1}.png`,
    sha1,
    size: bytes.length,
    crc32: crc32(bytes),
    include_in_pass: Number(input.includeInPass),
    version: ctx.ids.token(16),
    updated_at: ctx.clock.now(),
  };
  await ctx.env.BUCKET.put(next.r2_key, bytes, { httpMetadata: { contentType: 'image/png' } });
  return save(ctx, actor, pass, scope, previous, next);
}

export async function updateMemberPhoto(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  includeInPass: boolean,
  scope: ScopeArg,
) {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  const previous = await memberPhoto(ctx.env.DB, pass.orgId, passId);
  if (!previous) throw missing();
  await allowWallet(ctx, pass, includeInPass);
  return save(ctx, actor, pass, scope, previous, {
    ...previous,
    include_in_pass: Number(includeInPass),
    version: ctx.ids.token(16),
    updated_at: ctx.clock.now(),
  });
}

export async function deleteMemberPhoto(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: ScopeArg,
) {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  const previous = await memberPhoto(ctx.env.DB, pass.orgId, passId);
  if (!previous) throw missing();
  return save(ctx, actor, pass, scope, previous, null);
}
