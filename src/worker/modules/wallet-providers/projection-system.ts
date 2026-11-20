import type { JobOf } from '../../jobs/types.ts';
import { batch } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getVersion } from '../templates/repo.ts';
import { releaseAuditStmt } from '../templates/repo-release-audit.ts';
import { type ApprovalRow, getLatestRelease } from '../templates/repo-releases.ts';
import { buildProjectionCandidate } from './projection-candidate-build.ts';
import { publishableSchema } from './projection-contract.ts';
import { computeProjectionPins, unreleasable } from './projection-pins.ts';
import { publish } from './projection-release-service.ts';
import {
  captureProjectionProof,
  failedWrite,
  pinProjectionContext,
  scopedCandidate,
} from './projection-service-support.ts';
import {
  isSystemAuthored,
  SYSTEM_AUTHOR,
  SYSTEM_REVIEWER,
  systemAuthority,
} from './projection-system-authority.ts';
import {
  insertProjectionApprovalStmt,
  insertProjectionCandidateStmt,
  type ProjectionCandidate,
  type ProjectionScope,
  selectProjectionApprovals,
  selectProjectionCandidates,
} from './repo-projection-store.ts';

type SystemProjectionJob = JobOf<'wallet.projection_system'>;

const skipped = (ctx: ServiceContext, job: SystemProjectionJob, reason: string): void =>
  ctx.log.info('wallet.projection_system_skipped', {
    orgId: job.orgId,
    code: 'WALLET_PROJECTION_SYSTEM_SKIPPED',
    reason,
    provider: job.provider,
  });

/**
 * CW7b. An Apple release published: the platform authors the provider candidate for the same
 * source (author `SYSTEM_AUTHOR`). When the report has no `holder` or `door` item nothing is lost
 * that anyone would notice, so the platform approves and publishes it too (`SYSTEM_REVIEWER`);
 * otherwise it waits for one human approval, from any reviewer, the version's author included.
 * Only this job writes with system authority, and only while the org is active.
 */
export async function runSystemProjection(
  ctx: ServiceContext,
  job: SystemProjectionJob,
): Promise<void> {
  ctx = pinProjectionContext(ctx);
  const { orgId, mode, provider, templateId } = job;
  if (!publishableSchema(provider, 2)) return skipped(ctx, job, 'provider not open');
  const scope: ProjectionScope = { orgId, mode, provider, templateId };
  const proof = await captureProjectionProof(ctx);
  const db = ctx.env.DB;
  const earlier = (await selectProjectionCandidates(db, scope, proof)).find(
    (c) => isSystemAuthored(c) && c.sourceReleaseId === job.sourceReleaseId,
  );
  const reviewer = systemAuthority('reviewer', orgId, mode);
  // A retry resumes where the last run stopped: candidate, then approval, then release.
  let candidate = earlier ?? null;
  if (!candidate) {
    const version = await getVersion(db, templateId, job.version);
    if (!version) return skipped(ctx, job, 'version missing');
    const { pins, report } = await computeProjectionPins(ctx, provider, version);
    if (unreleasable(report)) return skipped(ctx, job, report.status.kind);
    const author = systemAuthority('author', orgId, mode);
    candidate = await buildProjectionCandidate(
      ctx,
      scope,
      {
        sourceReleaseId: job.sourceReleaseId,
        version: job.version,
        projection: { schema: 2, provider, approvedOmissions: pins.approvedOmissions },
        authorId: SYSTEM_AUTHOR,
      },
      proof,
    ).catch((error: unknown) => {
      if (!(error instanceof ConflictError)) throw error;
      skipped(ctx, job, error.code);
      return null;
    });
    if (!candidate) return;
    const created = candidate;
    const made = await batch(db, [
      insertProjectionCandidateStmt(db, created, author, ctx.clock.now(), proof),
      audit(ctx, created, 'candidate', created.id, 'template.system_candidate', SYSTEM_AUTHOR),
    ]);
    if (!made[0]?.meta.changes) return failedWrite(ctx, author);
  }
  if (candidate.projection.schema !== 2 || candidate.projection.approvedOmissions.length > 0)
    return;
  const head = await getLatestRelease(db, scope);
  if (head?.candidateId === candidate.id) return;

  let checked: ProjectionCandidate;
  try {
    checked = await scopedCandidate(ctx, scope, candidate.id, candidate.candidateHash, proof);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    return skipped(ctx, job, error.code);
  }
  const have = (await selectProjectionApprovals(db, scope, proof)).find(
    (a) => a.candidateId === checked.id && a.reviewerId === SYSTEM_REVIEWER,
  );
  const approval: ApprovalRow = have ?? {
    id: ctx.ids.id(),
    candidateId: checked.id,
    candidateHash: checked.candidateHash,
    reviewerId: SYSTEM_REVIEWER,
    kind: 'peer',
    createdAt: ctx.clock.now(),
  };
  if (!have) {
    const approved = await batch(db, [
      insertProjectionApprovalStmt(db, approval, checked, reviewer, ctx.clock.now(), proof),
      audit(ctx, checked, 'approval', approval.id, 'template.system_approve', SYSTEM_REVIEWER),
    ]);
    if (!approved[0]?.meta.changes) return failedWrite(ctx, reviewer);
  }
  await publish(
    ctx,
    reviewer,
    scope,
    checked,
    approval,
    head?.generation ?? 0,
    'release',
    null,
    proof,
  );
}

const audit = (
  ctx: ServiceContext,
  candidate: ProjectionCandidate,
  entity: 'candidate' | 'approval',
  id: string,
  action: string,
  userId: string,
) =>
  releaseAuditStmt(
    ctx.env.DB,
    ctx,
    entity,
    id,
    candidate.orgId,
    userId,
    candidate.templateId,
    action,
    {
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      mode: candidate.mode,
      provider: candidate.provider,
      autoPublish:
        candidate.projection.schema === 2 && candidate.projection.approvedOmissions.length === 0,
    },
  );
