import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  activeRelease,
  requireApprovedRelease,
  type TemplateRelease,
} from '../templates/releases.ts';
import type { TenantPassWrite } from './http.ts';
import type { PublishOptions } from './publish.ts';
import type { Pass } from './repo.ts';
import { tenantPassAuthorityValid } from './repo-authority.ts';
import { hasNoReleaseHistory } from './repo-release.ts';

export function releaseChanged(): ConflictError {
  return new ConflictError(
    'The approved template release changed. Reload and retry.',
    'TEMPLATE_RELEASE_CONFLICT',
  );
}

export type AppleRelease = TemplateRelease & { provider: 'apple' };

function isAppleRelease(release: TemplateRelease): release is AppleRelease {
  return release.provider === 'apple';
}

export async function resolvePublishRelease(
  ctx: ServiceContext,
  pass: Pass,
  version: string,
  expected: PublishOptions['expectedRelease'],
  captured: AppleRelease | undefined,
): Promise<AppleRelease> {
  let approved: TemplateRelease;
  try {
    approved = await requireApprovedRelease(ctx, pass.templateId, pass.orgId, pass.mode, 'apple');
  } catch (error) {
    if (
      (expected !== undefined || captured !== undefined) &&
      error instanceof ConflictError &&
      error.code === 'TEMPLATE_RELEASE_REQUIRED'
    )
      throw releaseChanged();
    throw error;
  }
  if (
    !isAppleRelease(approved) ||
    approved.templateId !== pass.templateId ||
    (approved.orgId !== null && approved.orgId !== pass.orgId) ||
    approved.mode !== pass.mode ||
    approved.version !== version ||
    (expected !== undefined &&
      (approved.id !== expected?.id || approved.generation !== expected?.generation)) ||
    (captured !== undefined &&
      (approved.id !== captured.id ||
        approved.generation !== captured.generation ||
        approved.orgId !== captured.orgId ||
        approved.templateId !== captured.templateId ||
        approved.mode !== captured.mode ||
        approved.version !== captured.version ||
        approved.candidateHash !== captured.candidateHash))
  )
    throw releaseChanged();
  return approved;
}

export async function resolveLegacyRelease(
  ctx: ServiceContext,
  pass: Pass,
): Promise<AppleRelease | null> {
  const approved = await activeRelease(ctx, pass.templateId, pass.orgId, pass.mode, 'apple');
  if (!approved) {
    if (!(await hasNoReleaseHistory(ctx.env.DB, pass.templateId, pass.orgId, pass.mode)))
      throw releaseChanged();
    return null;
  }
  if (
    !isAppleRelease(approved) ||
    approved.templateId !== pass.templateId ||
    (approved.orgId !== null && approved.orgId !== pass.orgId) ||
    approved.mode !== pass.mode ||
    approved.version !== pass.templateVersion
  )
    throw releaseChanged();
  return approved;
}

export async function assertReleaseFence(
  ctx: ServiceContext,
  pass: Pass,
  release: AppleRelease | undefined,
  requireNoReleaseHistory: boolean,
): Promise<void> {
  if (release) await resolvePublishRelease(ctx, pass, release.version, undefined, release);
  else if (requireNoReleaseHistory && (await resolveLegacyRelease(ctx, pass)))
    throw releaseChanged();
}

export function assertReleaseArtifact(
  release: TemplateRelease | undefined,
  template: { id: string; version: string },
): void {
  if (release && (template.id !== release.templateId || template.version !== release.version))
    throw releaseChanged();
}

export async function assertPublishAuthority(
  ctx: ServiceContext,
  authority: TenantPassWrite,
): Promise<void> {
  if (!(await tenantPassAuthorityValid(ctx.env.DB, authority, ctx.clock.now())))
    throw new ConflictError('Your access changed. Reload and retry.', 'PASS_CONFLICT');
}
