import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireApprovedRelease, type TemplateRelease } from '../templates/releases.ts';
import { assertTenantCreateAuthority } from './create-authority.ts';
import type { CreateParams } from './create-types.ts';
import { connectionForPass } from './repo-read-connection.ts';
import { getCreateTemplate, getOrg } from './repo-read-issuance.ts';

export function releaseChanged(): ConflictError {
  return new ConflictError(
    'The approved template release changed. Review the pass again before issuing it.',
    'TEMPLATE_RELEASE_CONFLICT',
  );
}

function sameRelease(a: TemplateRelease, b: TemplateRelease): boolean {
  return (
    a.id === b.id &&
    a.generation === b.generation &&
    a.templateId === b.templateId &&
    a.orgId === b.orgId &&
    a.mode === b.mode &&
    a.provider === b.provider &&
    a.version === b.version &&
    a.candidateHash === b.candidateHash
  );
}

async function assertCreateTemplate(
  ctx: ServiceContext,
  p: Pick<CreateParams, 'orgId' | 'templateId'>,
  wasPinned = false,
): Promise<void> {
  const template = await getCreateTemplate(ctx.env.DB, p.templateId);
  if (template?.status !== 'active' || (template.orgId !== null && template.orgId !== p.orgId)) {
    if (wasPinned) throw releaseChanged();
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  }
}

async function requiredRelease(
  ctx: ServiceContext,
  p: Pick<CreateParams, 'orgId' | 'templateId' | 'mode'>,
  reviewed: boolean,
  wasPinned = false,
): Promise<TemplateRelease> {
  try {
    return await requireApprovedRelease(ctx, p.templateId, p.orgId, p.mode, 'apple');
  } catch (error) {
    if (error instanceof ConflictError && error.code === 'TEMPLATE_RELEASE_REQUIRED') {
      // The lookup initializes baked templates; mask inaccessible initial targets as 404.
      await assertCreateTemplate(ctx, p, wasPinned);
      if (reviewed) throw releaseChanged();
    }
    throw error;
  }
}

/**
 * For API keys that send no release fields: the scope's effective release, which the INSERT
 * then fences like a reviewed one. Without one the caller learns what to do.
 */
export async function effectiveApiRelease(
  ctx: ServiceContext,
  p: Pick<CreateParams, 'orgId' | 'templateId' | 'mode'>,
): Promise<TemplateRelease> {
  try {
    return await requiredRelease(ctx, p, false);
  } catch (error) {
    if (error instanceof ConflictError && error.code === 'TEMPLATE_RELEASE_REQUIRED')
      throw new ConflictError(
        'The template has no approved release for this mode. Approve and publish a release in the admin console, then retry.',
        'TEMPLATE_RELEASE_REQUIRED',
      );
    throw error;
  }
}

export function validateCreateReview(p: CreateParams): boolean {
  if ((p.mode !== 'live' && p.mode !== 'test') || !p.templateVersion)
    throw new ValidationError('Review the mode and template version before issuing the pass.');
  const hasId = p.releaseId !== undefined;
  const hasGeneration = p.releaseGeneration !== undefined;
  const requiresReview = p.execution.kind === 'tenant';
  if (
    hasId !== hasGeneration ||
    (requiresReview && !hasId) ||
    (hasId &&
      (!p.releaseId ||
        typeof p.releaseGeneration !== 'number' ||
        !Number.isSafeInteger(p.releaseGeneration) ||
        p.releaseGeneration < 1))
  )
    throw releaseChanged();
  return hasId;
}

/** Pin the reviewed release, or resolve it for a trusted automated issuance. */
export async function resolveCreateRelease(
  ctx: ServiceContext,
  p: CreateParams,
): Promise<TemplateRelease> {
  const hasId = validateCreateReview(p);
  const org = await getOrg(ctx.env.DB, p.orgId);
  if (org?.status !== 'active') throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const release = await requiredRelease(ctx, p, hasId);
  if (
    release.templateId !== p.templateId ||
    (release.orgId !== null && release.orgId !== p.orgId) ||
    release.mode !== p.mode ||
    release.provider !== 'apple' ||
    p.templateVersion !== release.version ||
    (hasId && (p.releaseId !== release.id || p.releaseGeneration !== release.generation))
  )
    throw releaseChanged();
  return release;
}

async function assertApprovedRelease(
  ctx: ServiceContext,
  p: CreateParams,
  release: TemplateRelease,
): Promise<void> {
  const current = await requiredRelease(ctx, p, true, true);
  if (!sameRelease(current, release)) throw releaseChanged();
}

export async function assertCreateAuthority(
  ctx: ServiceContext,
  p: CreateParams,
  generation: number | null,
  release: TemplateRelease,
): Promise<void> {
  await assertTenantCreateAuthority(ctx, p);
  const db = ctx.env.DB;
  const org = await getOrg(db, p.orgId);
  if (org?.status !== 'active') throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  await assertCreateTemplate(ctx, p, true);
  await assertApprovedRelease(ctx, p, release);
  if (p.connectionId) {
    const connection = await connectionForPass(
      db,
      p.connectionId,
      p.orgId,
      p.mode,
      p.expectedConnectionMode,
    );
    if (!connection || connection.generation !== generation)
      throw new ConflictError('The connection changed. Reload and retry.', 'PASS_CONFLICT');
  }
}
