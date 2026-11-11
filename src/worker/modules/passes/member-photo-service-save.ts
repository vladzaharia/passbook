import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import {
  advanceImageWrite,
  assertImageWriteCurrent,
  type ImageWriteState,
  retirePassImageObject,
} from './asset-service-image-write.ts';
import type { TenantPassWrite } from './http.ts';
import { memberPhotoDto } from './member-photo-service-metadata.ts';
import { publishPass } from './publish.ts';
import { tenantPassAuthorityValid } from './repo-authority.ts';
import type { ImageMutationResult } from './repo-history-image.ts';
import { type MemberPhotoRow, replaceMemberPhoto } from './repo-member-photo.ts';
import { replaceMemberPhotoGranted } from './repo-member-photo-grant.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';

async function clean(ctx: ServiceContext, row: MemberPhotoRow | null, candidateId?: number | null) {
  if (row) await retirePassImageObject(ctx, row.r2_key, row.pass_id, candidateId);
}

async function cleanAfterFailure(
  ctx: ServiceContext,
  row: MemberPhotoRow | null,
  candidateId?: number | null,
) {
  try {
    await clean(ctx, row, candidateId);
  } catch (error) {
    ctx.log.warn('pass.image_cleanup_failed', { code: 'PASS_IMAGE_CLEANUP_FAILED', error });
  }
}

export async function saveMemberPhoto(
  ctx: ServiceContext,
  actor: Actor,
  initial: ImageWriteState,
  scope: ScopeArg,
  previous: MemberPhotoRow | null,
  next: MemberPhotoRow | null,
  authority?: TenantPassWrite,
) {
  const { pass } = initial;
  const uploaded = next && next.r2_key !== previous?.r2_key ? next : null;
  let staged: ImageMutationResult;
  try {
    const guard = {
      pass,
      imageGeneration: initial.imageGeneration,
      ...(uploaded ? { uploadKey: uploaded.r2_key } : {}),
    };
    staged = authority
      ? await replaceMemberPhotoGranted(ctx, next, previous?.version ?? null, {
          ...guard,
          authority,
        })
      : await replaceMemberPhoto(ctx.env.DB, pass.orgId, pass.id, next, previous?.version ?? null, {
          ...guard,
          now: ctx.clock.now(),
        });
  } catch (error) {
    // The response may have been lost after commit. A unique next version identifies our write.
    if (next && !previous) {
      const uncertain = {
        pass: { ...pass, linkGeneration: pass.linkGeneration + 1 },
        imageGeneration: initial.imageGeneration + 1,
      };
      try {
        const restored = await replaceMemberPhoto(
          ctx.env.DB,
          pass.orgId,
          pass.id,
          previous,
          next.version,
          {
            pass: uncertain.pass,
            imageGeneration: uncertain.imageGeneration,
            now: ctx.clock.now(),
          },
        );
        if (restored.saved) await cleanAfterFailure(ctx, next, restored.candidateId);
      } catch (restoreError) {
        ctx.log.error('pass.photo_restore_failed', {
          passId: pass.id,
          code: 'MEMBER_PHOTO_RESTORE_FAILED',
          error: restoreError,
        });
      }
    }
    await cleanAfterFailure(ctx, uploaded);
    throw error;
  }
  if (!staged.saved) {
    await cleanAfterFailure(ctx, uploaded);
    if (authority && !(await tenantPassAuthorityValid(ctx.env.DB, authority, ctx.clock.now())))
      throw new ForbiddenError();
    throw new ConflictError(
      'The pass or photo changed; reload and try again.',
      'MEMBER_PHOTO_CHANGED',
    );
  }
  const state = advanceImageWrite(initial, staged);
  const currentPass = state.pass;
  try {
    await assertImageWriteCurrent(ctx, state, authority);
    if (previous?.include_in_pass || next?.include_in_pass) {
      const published = await publishPass(ctx, {
        passId: pass.id,
        orgScope: scope,
        cause: actor.type === 'api_key' ? 'api' : 'admin',
        actor,
        authority,
        expectedImageGeneration: state.imageGeneration,
        mutate: (current) => {
          if (
            current.orgId !== currentPass.orgId ||
            current.mode !== currentPass.mode ||
            current.version !== currentPass.version ||
            current.templateId !== currentPass.templateId ||
            current.templateVersion !== currentPass.templateVersion ||
            current.releaseId !== currentPass.releaseId ||
            current.serial !== currentPass.serial ||
            current.authToken !== currentPass.authToken ||
            current.downloadToken !== currentPass.downloadToken ||
            current.identityId !== currentPass.identityId ||
            current.holderEmail !== currentPass.holderEmail ||
            current.ownerUserId !== currentPass.ownerUserId ||
            current.linkGeneration !== currentPass.linkGeneration ||
            current.credentialGeneration !== currentPass.credentialGeneration ||
            current.lifecycleGeneration !== currentPass.lifecycleGeneration ||
            current.revision !== currentPass.revision ||
            current.status !== currentPass.status ||
            current.removedAt !== currentPass.removedAt
          )
            throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
          return {};
        },
        force: true,
      });
      await assertImageWriteCurrent(
        ctx,
        { pass: published.pass, imageGeneration: state.imageGeneration },
        authority,
      );
    }
  } catch (error) {
    try {
      const restored = await replaceMemberPhoto(
        ctx.env.DB,
        pass.orgId,
        pass.id,
        previous,
        next?.version ?? null,
        {
          pass: state.pass,
          imageGeneration: state.imageGeneration,
          now: ctx.clock.now(),
          ...(staged.candidateId === null ? {} : { candidateId: staged.candidateId }),
        },
      );
      if (restored.saved) await cleanAfterFailure(ctx, next, restored.candidateId);
      else
        ctx.log.error('pass.photo_restore_failed', {
          passId: pass.id,
          code: 'MEMBER_PHOTO_RESTORE_FAILED',
        });
    } catch (restoreError) {
      ctx.log.error('pass.photo_restore_failed', {
        passId: pass.id,
        code: 'MEMBER_PHOTO_RESTORE_FAILED',
        error: restoreError,
      });
    }
    if (previous && staged.candidateId !== null)
      await cleanAfterFailure(ctx, previous, staged.candidateId);
    await cleanAfterFailure(ctx, uploaded);
    throw error;
  }
  if (previous) await clean(ctx, previous, staged.candidateId);
  await recordAudit(ctx, {
    orgId: pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: next ? 'pass.photo.put' : 'pass.photo.delete',
    targetType: 'pass',
    targetId: pass.id,
    detail: { includeInPass: next?.include_in_pass === 1 },
  });
  return memberPhotoDto(ctx, pass, next);
}
