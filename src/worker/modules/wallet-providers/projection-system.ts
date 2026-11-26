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
  const reviewer = systemAuthority('reviewer', orgId, mode);
  // A fresh platform candidate for this source: pins computed now, written under the system author. A twin
  // written by a concurrent job (same pins, the unique index of 0230) is adopted, not duplicated.
  const createFresh = async (): Promise<ProjectionCandidate | null> => {
    const version = await getVersion(db, templateId, job.version);
    if (!version) {
      skipped(ctx, job, 'version missing');
      return null;
    }
    const { pins, report } = await computeProjectionPins(ctx, provider, version, 'dry', orgId);
    if (unreleasable(report)) {
      skipped(ctx, job, report.status.kind);
      return null;
    }
    const author = systemAuthority('author', orgId, mode);
    const created = await buildProjectionCandidate(
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
    if (!created) return null;
    let made: boolean;
    try {
      made = await writeProjectionCandidate(ctx, created, author, {
        action: 'template.system_candidate',
        detail: auditDetail(created),
      });
    } catch (error) {
      if (!(await findSystemCandidate(ctx, scope, job))) throw error;
      made = false;
    }
    if (made) return created;
    const twin = await findSystemCandidate(ctx, scope, job);
    return twin ?? failedWrite(ctx, author);
  };
  // A retry resumes where the last run stopped: candidate, then approval, then release.
  const reused = await findSystemCandidate(ctx, scope, job);
  let candidate = reused ?? (await createFresh());
  if (!candidate) return;
  if (candidate.projection.schema !== 2 || candidate.projection.approvedOmissions.length > 0)
    return;
  const head = await getLatestRelease(db, scope);
  if (head?.candidateId === candidate.id) return;

  const check = async (c: ProjectionCandidate): Promise<ProjectionCandidate | null> => {
    try {
      return await scopedCandidate(ctx, scope, c.id, c.candidateHash);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      skipped(ctx, job, error.code);
      return null;
    }
  };
  let checked = await check(candidate);
  if (!checked && reused) {
    // The reused candidate went stale (a compiler or pipeline bump, a website, credential or epoch change) before
    // it was released. A fresh one has different pins, so the unique index allows it; the stale one is superseded
    // by being older (the backfill reads only the newest platform candidate of a source).
    candidate = await createFresh();
    if (!candidate || candidate.id === reused.id) return;
    if (candidate.projection.schema !== 2 || candidate.projection.approvedOmissions.length > 0)
      return;
    checked = await check(candidate);
  }
  if (!checked) return;
  const ready = checked;
  const have = (await selectProjectionApprovals(db, scope)).find(
    (a) => a.candidateId === ready.id && a.reviewerId === SYSTEM_REVIEWER,
  );
  const approval: ApprovalRow = have ?? {
    id: ctx.ids.id(),
    candidateId: ready.id,
    candidateHash: ready.candidateHash,
    reviewerId: SYSTEM_REVIEWER,
    kind: 'peer',
    createdAt: ctx.clock.now(),
  };
  if (!have) {
    const approved = await writeProjectionApproval(ctx, approval, ready, reviewer, {
      action: 'template.system_approve',
      detail: auditDetail(ready),
    });
    if (!approved) return failedWrite(ctx, reviewer);
  }
  // Samsung publishes only on a card Samsung reports launched (Test also takes one in testing): a mode that is not
  // released, or a Live card that is not launched yet, is a skip. The backfill drives it again later.
  if (
    provider === 'samsung' &&
    !(await ensureSamsungCard(ctx, ready.id, ready.candidateHash, CARD_STATE_MARGIN_MS))
  )
    return skipped(ctx, job, 'card not ready');
  await publish(ctx, reviewer, scope, ready, approval, head?.generation ?? 0, 'release', null);
}

// Newest first (`selectProjectionCandidates` orders by creation): a superseded stale candidate is never reused.
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
