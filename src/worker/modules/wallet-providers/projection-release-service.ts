import type {
  PublishTemplateRelease,
  RollbackTemplateRelease,
  TemplateRelease,
} from '../../../shared/contracts/template-releases.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { batch } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { authorizeTemplateWrite, type TemplateAuthority } from '../templates/access.ts';
import { releaseAuditStmt } from '../templates/repo-release-audit.ts';
import {
  type ApprovalRow,
  getApproval,
  getLatestRelease,
  getRelease,
} from '../templates/repo-releases.ts';
import type { WalletCredentialKeysetProof } from './instance-types.ts';
import {
  captureProjectionProof,
  changed,
  failedWrite,
  nativeScope,
  pinProjectionContext,
  releaseDto,
  requireProjectionProof,
  scopedCandidate,
  scopedTemplate,
} from './projection-service-support.ts';
import {
  insertProjectionReleaseStmt,
  type ProjectionCandidate,
  type ProjectionScope,
} from './repo-projection-store.ts';
import { ensureSamsungProjectionEvidence } from './samsung-verification.ts';

async function publish(
  ctx: ServiceContext,
  authority: TemplateAuthority,
  scope: ProjectionScope,
  candidate: ProjectionCandidate,
  approval: ApprovalRow,
  expectedGeneration: number,
  action: 'release' | 'rollback',
  targetReleaseId: string | null,
  proof: WalletCredentialKeysetProof,
): Promise<TemplateRelease> {
  if (
    approval.candidateId !== candidate.id ||
    approval.candidateHash !== candidate.candidateHash ||
    approval.reviewerId === candidate.authorId ||
    approval.reviewerId === candidate.versionAuthorId
  )
    throw changed();
  const db = ctx.env.DB;
  const head = await getLatestRelease(db, scope);
  if ((head?.generation ?? 0) !== expectedGeneration) throw changed();
  if (
    candidate.provider !== 'samsung' ||
    !(await ensureSamsungProjectionEvidence(ctx, candidate.id, candidate.candidateHash, proof))
  )
    throw changed();
  const id = ctx.ids.id();
  const results = await batch(db, [
    insertProjectionReleaseStmt(db, {
      id,
      candidate,
      approval,
      authority,
      expectedGeneration,
      expectedReleaseId: head?.id ?? null,
      action,
      targetReleaseId,
      now: ctx.clock.now(),
      ...proof,
    }),
    releaseAuditStmt(
      db,
      ctx,
      'release',
      id,
      scope.orgId,
      authority.userId,
      scope.templateId,
      action === 'release' ? 'template.release' : 'template.rollback',
      {
        releaseId: id,
        candidateId: candidate.id,
        approvalId: approval.id,
        candidateHash: candidate.candidateHash,
        mode: scope.mode,
        provider: scope.provider,
        generation: expectedGeneration + 1,
        targetReleaseId,
      },
    ),
  ]);
  if (!results[0]?.meta.changes) return failedWrite(ctx, authority);
  const row = await getRelease(db, id);
  if (!row) throw new Error('Committed wallet projection release was not found.');
  await requireProjectionProof(ctx, proof);
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
  const proof = await captureProjectionProof(ctx);
  const candidate = await scopedCandidate(ctx, scope, body.candidateId, body.candidateHash, proof);
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
    proof,
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
  const proof = await captureProjectionProof(ctx);
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
    proof,
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
    proof,
  );
}
