import type {
  PublishTemplateRelease,
  RollbackTemplateRelease,
  TemplateRelease,
} from '../../../shared/contracts/template-releases.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { authorizeTemplateWrite } from '../templates/access.ts';
import {
  type ApprovalRow,
  getApproval,
  getLatestRelease,
  getRelease,
} from '../templates/repo-releases.ts';
import { publishableSchema } from './projection-contract.ts';
import {
  changed,
  failedWrite,
  nativeScope,
  pinProjectionContext,
  releaseDto,
  schemaRefused,
  scopedCandidate,
  scopedTemplate,
  storeReleaseArt,
} from './projection-service-support.ts';
import { isSystemAuthored, type ProjectionAuthority } from './projection-system-authority.ts';
import { writeProjectionRelease } from './repo-projection-release-write.ts';
import type { ProjectionCandidate, ProjectionScope } from './repo-projection-store.ts';
import { ensureSamsungCard } from './samsung-verification.ts';

/**
 * A publish cuts art before it writes, and the release trigger reads the card-state row at the write: the row
 * must outlast that work, or the publish reads the card again.
 */
export const CARD_STATE_MARGIN_MS = 60_000;

export async function publish(
  ctx: ServiceContext,
  authority: ProjectionAuthority,
  scope: ProjectionScope,
  candidate: ProjectionCandidate,
  approval: ApprovalRow,
  expectedGeneration: number,
  action: 'release' | 'rollback',
  targetReleaseId: string | null,
): Promise<TemplateRelease> {
  if (
    approval.candidateId !== candidate.id ||
    approval.candidateHash !== candidate.candidateHash ||
    (approval.kind !== 'sole' &&
      (approval.reviewerId === candidate.authorId ||
        (approval.reviewerId === candidate.versionAuthorId && !isSystemAuthored(candidate))))
  )
    throw changed();
  const db = ctx.env.DB;
  const head = await getLatestRelease(db, scope);
  if ((head?.generation ?? 0) !== expectedGeneration) throw changed();
  if (!publishableSchema(candidate.provider, candidate.projection.schema))
    throw schemaRefused(candidate.provider);
  if (
    candidate.provider === 'samsung' &&
    !(await ensureSamsungCard(ctx, candidate.id, candidate.candidateHash, CARD_STATE_MARGIN_MS))
  )
    throw changed();
  await storeReleaseArt(ctx, candidate, action === 'rollback' ? 'carry' : 'exact');
  const id = ctx.ids.id();
  const written = await writeProjectionRelease(ctx, {
    id,
    candidate,
    approval,
    authority,
    expectedGeneration,
    expectedReleaseId: head?.id ?? null,
    action,
    targetReleaseId,
    now: ctx.clock.now(),
    audit: {
      action:
        action === 'rollback'
          ? 'template.rollback'
          : authority.kind === 'system'
            ? 'template.system_release'
            : 'template.release',
      detail: {
        releaseId: id,
        candidateId: candidate.id,
        approvalId: approval.id,
        candidateHash: candidate.candidateHash,
        mode: scope.mode,
        provider: scope.provider,
        generation: expectedGeneration + 1,
        targetReleaseId,
      },
    },
  });
  if (!written) return failedWrite(ctx, authority);
  const row = await getRelease(db, id);
  if (!row) throw new Error('Committed wallet projection release was not found.');
  // Objects already in wallets need no job here. Google applies class fields to every object itself; what is
  // compiled into the object (a Generic class holds only its sharing mode, so the whole card) is resent
  // because this insert marked every copy of the template dirty (0037 `wallet_provider_dirty_release`) and the
  // minute drain sends each under the new release: 30 a minute, class rewrite behind one CAS row, Google's
  // quota backoff in `sync-errors.ts`. A rollback is the same insert. Review (`reviewStatus`) changes no object
  // field. Pinned by google-release-objects.test.ts. The job below only brings each class up, once.
  if (candidate.provider === 'google' && action === 'release')
    await queueGoogleReconcile(ctx, scope, row.version, row.generation);
  return releaseDto(row, candidate);
}
export async function publishProjectionRelease(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  body: PublishTemplateRelease,
): Promise<TemplateRelease> {
  ctx = pinProjectionContext(ctx);
  await scopedTemplate(ctx, auth, templateId, body);
  const scope = nativeScope(templateId, body);
  const authority = await authorizeTemplateWrite(ctx, auth, scope.orgId, 'templates:publish');
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const candidate = await scopedCandidate(ctx, scope, body.candidateId, body.candidateHash);
  const approval = await getApproval(ctx.env.DB, body.approvalId);
  if (!approval) throw changed();
  return publish(
    ctx,
    authority,
    scope,
    candidate,
    approval,
    body.expectedGeneration,
    'release',
    null,
  );
}
export async function rollbackProjectionRelease(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  body: RollbackTemplateRelease,
): Promise<TemplateRelease> {
  ctx = pinProjectionContext(ctx);
  await scopedTemplate(ctx, auth, templateId, body);
  const scope = nativeScope(templateId, body);
  const authority = await authorizeTemplateWrite(ctx, auth, scope.orgId, 'templates:publish');
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const target = await getRelease(ctx.env.DB, body.releaseId);
  if (
    !target ||
    target.templateId !== templateId ||
    target.orgId !== scope.orgId ||
    target.mode !== scope.mode ||
    target.provider !== scope.provider ||
    target.source !== 'approved' ||
    !target.candidateId ||
    !target.approvalId ||
    target.candidateHash !== body.candidateHash ||
    target.generation >= body.expectedGeneration
  )
    throw changed();
  const candidate = await scopedCandidate(
    ctx,
    scope,
    target.candidateId,
    body.candidateHash,
    'carry',
  );
  const approval = await getApproval(ctx.env.DB, target.approvalId);
  if (!approval) throw changed();
  return publish(
    ctx,
    authority,
    scope,
    candidate,
    approval,
    body.expectedGeneration,
    'rollback',
    target.id,
  );
}

/** Best effort: a missed message only leaves classes to follow on the next pass edit. */
async function queueGoogleReconcile(
  ctx: ServiceContext,
  scope: { orgId: string; mode: 'live' | 'test'; templateId: string },
  version: string,
  generation: number,
): Promise<void> {
  try {
    await ctx.env.JOBS.send({
      kind: 'wallet.google_reconcile',
      orgId: scope.orgId,
      mode: scope.mode,
      templateId: scope.templateId,
      version,
      generation,
    });
  } catch {
    ctx.log.warn('wallet.google_reconcile_not_queued', { code: 'WALLET_GOOGLE_RECONCILE' });
  }
}
