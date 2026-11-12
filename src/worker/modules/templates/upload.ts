import type { z } from 'zod';
import type {
  UploadTemplateQuerySchema,
  UploadTemplateResponseSchema,
} from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { actorOf } from '../../platform/context.ts';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  UpstreamError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { assertTemplateAuthority, authorizeTemplateWrite } from './access.ts';
import { LIMITS } from './package/unzip.ts';
import { getOrgName } from './repo.ts';
import { queueTemplateUpload, recordUploadStartFailure } from './repo-upload.ts';

/** Multipart framing on top of the 15 MB archive. */
export const UPLOAD_BODY_LIMIT = LIMITS.archiveBytes + 64 * 1024;

export async function acceptUpload(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  query: z.infer<typeof UploadTemplateQuerySchema>,
  archiveBytes: () => Promise<Uint8Array>,
): Promise<z.infer<typeof UploadTemplateResponseSchema>> {
  const orgId = query.orgId ?? null;
  const authority = await authorizeTemplateWrite(ctx, auth, orgId, 'templates:author');
  if (orgId && !(await getOrgName(ctx.env.DB, orgId)))
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const archive = await archiveBytes();
  if (archive.length > LIMITS.archiveBytes)
    throw new PayloadTooLargeError('The archive is larger than 15 MB.', 'ARCHIVE_TOO_LARGE');
  const isZip = archive[0] === 0x50 && archive[1] === 0x4b;
  if (!isZip) throw new BadRequestError('The file is not a zip archive.', 'NOT_A_ZIP');

  const uploadId = ctx.ids.id();
  const objectKey = `uploads/${uploadId}.zip`;
  const createdBy = authority.userId;
  const upload = { uploadId, orgId, objectKey, createdBy };
  await assertTemplateAuthority(ctx, authority);
  let importCreated = false;
  let startedAt = 0;
  try {
    await ctx.env.BUCKET.put(objectKey, archive, {
      httpMetadata: { contentType: 'application/zip' },
    });
    const now = ctx.clock.now();
    startedAt = now;
    const results = await queueTemplateUpload(
      ctx.env.DB,
      upload,
      query.name?.trim() || null,
      authority,
      now,
    );
    importCreated = !!results[0]?.results.length;
    if (!importCreated || !results[1]?.results.length) {
      await assertTemplateAuthority(ctx, authority);
      throw new ConflictError('The import could not be queued. Try again.', 'IMPORT_CONFLICT');
    }
    await assertTemplateAuthority(ctx, authority);
  } catch (error) {
    try {
      if (importCreated)
        await recordUploadStartFailure(ctx.env.DB, upload, startedAt, ctx.clock.now());
    } finally {
      await ctx.env.BUCKET.delete(objectKey);
    }
    throw error;
  }
  try {
    await ctx.env.TEMPLATE_IMPORT.create({
      id: uploadId,
      params: { ...upload, authority },
    });
  } catch (error) {
    ctx.log.error('templates.workflow_start_failed', {
      orgId: orgId,
      error: error instanceof Error ? error.name : 'unknown',
    });
    try {
      await recordUploadStartFailure(ctx.env.DB, upload, startedAt, ctx.clock.now());
    } finally {
      await ctx.env.BUCKET.delete(objectKey);
    }
    throw new UpstreamError('Could not start the import. Try again.', 'WORKFLOW_START');
  }
  const actor = actorOf(auth);
  await recordAudit(ctx, {
    orgId: orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'template.upload',
    targetType: 'template_import',
    targetId: uploadId,
    detail: { bytes: archive.length },
  });
  return { uploadId, workflowInstanceId: uploadId };
}
