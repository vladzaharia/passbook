import type { JobOf } from '../../jobs/types.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getVersion } from '../templates/repo.ts';
import { type ApprovalRow, getLatestRelease } from '../templates/repo-releases.ts';
import { buildProjectionCandidate } from './projection-candidate-build.ts';
import { publishableSchema } from './projection-contract.ts';
import { computeProjectionPins, unreleasable } from './projection-pins.ts';
import { CARD_STATE_MARGIN_MS, publish } from './projection-release-service.ts';
import {
  failedWrite,
  pinProjectionContext,
  scopedCandidate,
} from './projection-service-support.ts';
import {
  isSystemAuthored,
  SYSTEM_AUTHOR,
  SYSTEM_AUTHORED_PROVIDERS,
  SYSTEM_REVIEWER,
  systemAuthority,
} from './projection-system-authority.ts';
import {
  type ProjectionCandidate,
  type ProjectionScope,
  selectProjectionApprovals,
  selectProjectionCandidates,
} from './repo-projection-store.ts';
import { writeProjectionApproval, writeProjectionCandidate } from './repo-projection-write.ts';
import { ensureSamsungCard } from './samsung-verification.ts';

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
  try {
    await projectOnce(ctx, job);
  } catch (error) {
    // An org that is no longer active refuses the grant: a skip, not a failure the queue retries to the DLQ.
    if (error instanceof ForbiddenError && error.code === 'ORG_ACCESS_CHANGED')
      return skipped(ctx, job, 'org not active');
    throw error;
  }
}

async function projectOnce(ctx: ServiceContext, job: SystemProjectionJob): Promise<void> {
  ctx = pinProjectionContext(ctx);
  const { orgId, mode, provider, templateId } = job;
  if (!SYSTEM_AUTHORED_PROVIDERS.includes(provider) || !publishableSchema(provider, 2))
    return skipped(ctx, job, 'provider not open');
  const scope: ProjectionScope = { orgId, mode, provider, templateId };
  const credentialKeysetCommitment = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const db = ctx.env.DB;
  const earlier = await findSystemCandidate(ctx, scope, job);
  const reviewer = systemAuthority('reviewer', orgId, mode);
  // A retry resumes where the last run stopped: candidate, then approval, then release.
  let candidate = earlier ?? null;
  if (!candidate) {
    const version = await getVersion(db, templateId, job.version);
    if (!version) return skipped(ctx, job, 'version missing');
    const { pins, report } = await computeProjectionPins(ctx, provider, version, 'dry', orgId);
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
      credentialKeysetCommitment,
    ).catch((error: unknown) => {
      if (!(error instanceof ConflictError)) throw error;
      skipped(ctx, job, error.code);
      return null;
    });
    if (!candidate) return;
    const created = candidate;
    let made: boolean;
    try {
      made = await writeProjectionCandidate(ctx, created, author, {
        action: 'template.system_candidate',
        detail: auditDetail(created),
      });
    } catch (error) {
      // A concurrent job's twin (the unique index of 0230) is adopted below, not duplicated.
      if (!(await findSystemCandidate(ctx, scope, job))) throw error;
      made = false;
    }
    if (!made) {
      const twin = await findSystemCandidate(ctx, scope, job);
      if (!twin) return failedWrite(ctx, author);
      candidate = twin;
    }
  }
  if (candidate.projection.schema !== 2 || candidate.projection.approvedOmissions.length > 0)
    return;
  const head = await getLatestRelease(db, scope);
  if (head?.candidateId === candidate.id) return;

  let checked: ProjectionCandidate;
  try {
    checked = await scopedCandidate(ctx, scope, candidate.id, candidate.candidateHash);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    return skipped(ctx, job, error.code);
  }
  const have = (await selectProjectionApprovals(db, scope)).find(
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
    const approved = await writeProjectionApproval(ctx, approval, checked, reviewer, {
      action: 'template.system_approve',
      detail: auditDetail(checked),
    });
    if (!approved) return failedWrite(ctx, reviewer);
  }
  // Samsung publishes only on a card Samsung reports launched (Test also takes one in testing): a mode that is not
  // released, or a Live card that is not launched yet, is a skip. The backfill drives it again later.
  if (
    provider === 'samsung' &&
    !(await ensureSamsungCard(ctx, checked.id, checked.candidateHash, CARD_STATE_MARGIN_MS))
  )
    return skipped(ctx, job, 'card not ready');
  await publish(ctx, reviewer, scope, checked, approval, head?.generation ?? 0, 'release', null);
}

const findSystemCandidate = async (
  ctx: ServiceContext,
  scope: ProjectionScope,
  job: SystemProjectionJob,
) =>
  (await selectProjectionCandidates(ctx.env.DB, scope)).find(
    (c) => isSystemAuthored(c) && c.sourceReleaseId === job.sourceReleaseId,
  );

const auditDetail = (candidate: ProjectionCandidate) => ({
  candidateId: candidate.id,
  candidateHash: candidate.candidateHash,
  mode: candidate.mode,
  provider: candidate.provider,
  autoPublish:
    candidate.projection.schema === 2 && candidate.projection.approvedOmissions.length === 0,
});
