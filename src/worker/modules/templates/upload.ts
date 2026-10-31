import type { z } from 'zod';
import type {
  UploadTemplateQuerySchema,
  UploadTemplateResponseSchema,
} from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { actorOf } from '../../platform/context.ts';
import {
  BadRequestError,
  NotFoundError,
  PayloadTooLargeError,
  UpstreamError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { LIMITS } from './package/unzip.ts';
import { getOrgName, insertImport, setWorkflowRun, updateImport } from './repo.ts';

/** Multipart framing on top of the 15 MB archive. */
export const UPLOAD_BODY_LIMIT = LIMITS.archiveBytes + 64 * 1024;

export async function acceptUpload(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  query: z.infer<typeof UploadTemplateQuerySchema>,
  archive: Uint8Array,
): Promise<z.infer<typeof UploadTemplateResponseSchema>> {
  if (archive.length > LIMITS.archiveBytes)
    throw new PayloadTooLargeError('The archive is larger than 15 MB.', 'ARCHIVE_TOO_LARGE');
  const isZip = archive[0] === 0x50 && archive[1] === 0x4b;
  if (!isZip) throw new BadRequestError('The file is not a zip archive.', 'NOT_A_ZIP');
  const org = await getOrgName(ctx.env.DB, query.orgId);
  if (!org) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');

  const uploadId = ctx.ids.id();
  const objectKey = `uploads/${uploadId}.zip`;
  const createdBy = auth?.kind === 'session' ? auth.userId : null;
  await ctx.env.BUCKET.put(objectKey, archive, {
    httpMetadata: { contentType: 'application/zip' },
  });
  await insertImport(ctx.env.DB, {
    uploadId,
    orgId: org.id,
    name: query.name?.trim() || null,
    objectKey,
    createdBy,
    now: ctx.clock.now(),
  });
  try {
    await ctx.env.TEMPLATE_IMPORT.create({
      id: uploadId,
      params: { uploadId, orgId: org.id, objectKey, createdBy },
    });
  } catch (error) {
    ctx.log.error('templates.workflow_start_failed', {
      orgId: org.id,
      error: error instanceof Error ? error.name : 'unknown',
    });
    const now = ctx.clock.now();
    await setWorkflowRun(ctx.env.DB, uploadId, 'errored', now, { errorCode: 'WORKFLOW_START' });
    await updateImport(ctx.env.DB, uploadId, { step: 'failed', error: 'WORKFLOW_START' }, now);
    await ctx.env.BUCKET.delete(objectKey);
    throw new UpstreamError('Could not start the import. Try again.', 'WORKFLOW_START');
  }
  const actor = actorOf(auth);
  await recordAudit(ctx, {
    orgId: org.id,
    actorType: actor.type,
    actorId: actor.id,
    action: 'template.upload',
    targetType: 'template_import',
    targetId: uploadId,
    detail: { bytes: archive.length },
  });
  return { uploadId, workflowInstanceId: uploadId };
}
