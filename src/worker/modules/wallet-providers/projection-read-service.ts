import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  TemplateRelease,
  TemplateReleaseList,
  TemplateReleaseProvider,
  TemplateReleaseScope,
} from '../../../shared/contracts/template-releases.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getLatestRelease, listReleases as selectReleases } from '../templates/repo-releases.ts';
import {
  type NativeProvider,
  NativeProviderSchema,
  projectionPolicy,
  publishableSchema,
} from './projection-contract.ts';
import {
  type ApprovedProjection,
  type ApprovedProjectionScope,
  nativeScope,
  pinProjectionContext,
  releaseDto,
  sameScope,
  scopedTemplate,
  verifiedCandidate,
} from './projection-service-support.ts';
import { googleReleaseReviews } from './repo-google-class-write.ts';
import { projectionReleaseBindingValid } from './repo-projection.ts';
import {
  getProjectionCandidate,
  selectProjectionReleaseIds,
  selectReleasedProjectionCandidates,
} from './repo-projection-store.ts';

/** Provider card/release readiness only; recipient market/device eligibility is a separate gate. */
export async function getApprovedProjection(
  ctx: ServiceContext,
  scope: ApprovedProjectionScope,
): Promise<ApprovedProjection | null> {
  ctx = pinProjectionContext(ctx);
  try {
    await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  } catch (error) {
    if (error instanceof UnavailableError) return null;
    throw error;
  }
  return approvedProjection(ctx, scope);
}

async function approvedProjection(
  ctx: ServiceContext,
  scope: ApprovedProjectionScope,
): Promise<ApprovedProjection | null> {
  scope = { ...scope };
  const provider = NativeProviderSchema.safeParse(scope.provider);
  if (!provider.success) return null;
  const policy = projectionPolicy(provider.data);
  if (
    (scope.adapterRevision !== undefined && scope.adapterRevision !== policy.adapterRevision) ||
    (scope.audiencePolicyRevision !== undefined &&
      scope.audiencePolicyRevision !== policy.audiencePolicyRevision)
  )
    return null;
  const row = await getLatestRelease(ctx.env.DB, {
    templateId: scope.templateId,
    orgId: scope.orgId,
    mode: scope.mode,
    provider: provider.data,
  });
  if (
    row?.source !== 'approved' ||
    !row.candidateId ||
    !row.approvalId ||
    row.version !== scope.templateVersion
  )
    return null;
  const candidate = await getProjectionCandidate(ctx.env.DB, row.candidateId);
  if (
    !candidate ||
    !sameScope(candidate, { ...scope, provider: provider.data }) ||
    candidate.sourceReleaseId !== scope.appleReleaseId ||
    candidate.candidateHash !== row.candidateHash ||
    !(await verifiedCandidate(ctx, candidate))
  )
    return null;
  if (!publishableSchema(candidate.provider, candidate.projection.schema)) return null;
  if (
    !(await projectionReleaseBindingValid(ctx.env.DB, {
      releaseId: row.id,
      orgId: scope.orgId,
      mode: scope.mode,
      provider: provider.data,
      templateId: scope.templateId,
      version: scope.templateVersion,
      sourceReleaseId: scope.appleReleaseId,
      now: ctx.clock.now(),
    }))
  )
    return null;
  return { release: releaseDto(row, candidate), projection: candidate.projection };
}

async function activeProjectionReleaseWithProof(
  ctx: ServiceContext,
  templateId: string,
  orgId: string,
  mode: Mode,
  provider: NativeProvider,
): Promise<TemplateRelease | null> {
  const row = await getLatestRelease(ctx.env.DB, { templateId, orgId, mode, provider });
  if (!row?.candidateId) return null;
  const candidate = await getProjectionCandidate(ctx.env.DB, row.candidateId);
  if (!candidate) return null;
  return (
    (
      await approvedProjection(ctx, {
        templateId,
        orgId,
        mode,
        provider,
        templateVersion: row.version,
        appleReleaseId: candidate.sourceReleaseId,
      })
    )?.release ?? null
  );
}

export async function activeProjectionRelease(
  ctx: ServiceContext,
  templateId: string,
  orgId: string,
  mode: Mode,
  provider: TemplateReleaseProvider,
): Promise<TemplateRelease | null> {
  ctx = pinProjectionContext(ctx);
  const parsed = NativeProviderSchema.safeParse(provider);
  if (!parsed.success) return null;
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  return activeProjectionReleaseWithProof(ctx, templateId, orgId, mode, parsed.data);
}

export async function listProjectionReleases(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  scope: TemplateReleaseScope,
): Promise<TemplateReleaseList> {
  ctx = pinProjectionContext(ctx);
  await scopedTemplate(ctx, auth, templateId, scope);
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const native = nativeScope(templateId, scope);
  const [rows, candidates, releaseIds] = await Promise.all([
    selectReleases(ctx.env.DB, native),
    selectReleasedProjectionCandidates(ctx.env.DB, native),
    selectProjectionReleaseIds(ctx.env.DB, native),
  ]);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const items: TemplateRelease[] = [];
  for (const row of rows) {
    const candidate = row.candidateId ? candidatesById.get(row.candidateId) : null;
    if (candidate && releaseIds.has(row.id) && sameScope(candidate, native))
      items.push(releaseDto(row, candidate));
  }
  const active = await activeProjectionReleaseWithProof(
    ctx,
    templateId,
    scope.orgId,
    scope.mode,
    native.provider,
  );
  if (native.provider !== 'google') return { items, active, nextCursor: null };
  const reviews = await googleReleaseReviews(
    ctx.env.DB,
    [...items, ...(active ? [active] : [])].map((r) => r.id),
  );
  const reviewed = (r: TemplateRelease): TemplateRelease => {
    const googleReview = reviews.get(r.id);
    return googleReview ? { ...r, googleReview } : r;
  };
  return { items: items.map(reviewed), active: active && reviewed(active), nextCursor: null };
}
