import type { Mode } from '../../../shared/contracts/common.ts';
import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dispatchSafely } from '../delivery/issuance-intent.ts';
import { recordRolloutFailure } from '../templates/repo-rollout.ts';
import { publishPass } from './publish.ts';
import { passesForReissue } from './repo.ts';
import {
  type ReissuePrincipal,
  reissuePrincipalCheck,
  reissuePrincipalValid,
} from './repo-bulk-principal.ts';
import { hasWorkflowReleaseSnapshots, passesForWorkflowReissue } from './repo-workflow-releases.ts';
import { releaseMovePlan, type StampMove } from './stamps-keep.ts';

const REISSUE_PAGE = 100;

export interface ReissueParams {
  templateId: string | null;
  version: string | null;
  orgId: string | null;
  identityId?: string | null;
  /** Absent only for system workflows that intentionally cover both modes. */
  mode?: Mode;
  /** Durable snapshot set created atomically with an upgrade workflow. */
  workflowInstanceId?: string;
  /** The captured release for a single-organization, single-mode upgrade. */
  releaseId?: string;
  releaseGeneration?: number;
  cause: 'template_upgrade' | 'resign' | 'branding';
  /** Who started the run; absent for system runs. Re-checked before every page. */
  principal?: ReissuePrincipal;
  /** The operation that shows this run (a user-started one); absent for system runs. */
  operationId?: string;
  operationAttempt?: number;
}

export interface ReissuePageResult {
  nextCursor: string | null;
  changed: number;
  unchanged: number;
  failed: number;
  /** Present when some failed because the card holds more stamps than the new version allows. */
  aboveMax?: number;
  /** The starter lost access: the run stops without touching this page. */
  revoked?: true;
}

/**
 * Rebuilds one page of passes. A pass that fails validation under the new version is counted and
 * skipped; the others still move. Pushes are dispatched once per page.
 */
export async function reissuePage(
  ctx: ServiceContext,
  params: ReissueParams,
  cursor: string | null,
): Promise<ReissuePageResult> {
  if (
    params.principal &&
    !(await reissuePrincipalValid(ctx.env.DB, params.orgId, params.principal, ctx.clock.now()))
  ) {
    ctx.log.warn('bulk_reissue.principal_revoked', { code: 'REISSUE_PRINCIPAL_REVOKED' });
    return { nextCursor: null, changed: 0, unchanged: 0, failed: 0, revoked: true };
  }
  type Release = {
    orgId: string;
    mode: Mode;
    templateId: string;
    version: string;
    releaseId: string;
    generation: number;
  };
  let rows: { id: string; release?: Release }[];
  if (params.cause === 'template_upgrade') {
    const hasId = params.releaseId !== undefined;
    const hasGeneration = params.releaseGeneration !== undefined;
    if (
      !params.workflowInstanceId ||
      hasId !== hasGeneration ||
      (hasId &&
        (!params.releaseId ||
          typeof params.releaseGeneration !== 'number' ||
          !Number.isSafeInteger(params.releaseGeneration) ||
          params.releaseGeneration <= 0)) ||
      (params.templateId !== null && params.orgId !== null && params.mode !== undefined && !hasId)
    ) {
      throw new ConflictError(
        'The queued release is missing. Start the rebuild again.',
        'TEMPLATE_RELEASE_CONFLICT',
      );
    }
    if (!(await hasWorkflowReleaseSnapshots(ctx.env.DB, params.workflowInstanceId)))
      throw new ConflictError(
        'The queued release is missing. Start the rebuild again.',
        'TEMPLATE_RELEASE_CONFLICT',
      );
    const selected = await passesForWorkflowReissue(ctx.env.DB, {
      instanceId: params.workflowInstanceId,
      afterId: cursor,
      limit: REISSUE_PAGE,
      identityId: params.identityId ?? null,
    });
    rows = selected.map(({ id, ...release }) => ({ id, release }));
  } else {
    rows = await passesForReissue(ctx.env.DB, {
      templateId: params.templateId,
      orgId: params.orgId,
      identityId: params.identityId ?? null,
      ...(params.mode ? { mode: params.mode } : {}),
      afterId: cursor,
      limit: REISSUE_PAGE,
      skipVersion: null,
      // Branding restyles live passes; a voided pass stays as it is.
      activeOnly: params.cause !== 'resign',
    });
  }
  const result: ReissuePageResult = {
    nextCursor: null,
    changed: 0,
    unchanged: 0,
    failed: 0,
  };
  const plans = new Map<string, Promise<StampMove>>();
  const movePlan = (r: Release) => {
    const id = `${r.orgId}|${r.mode}|${r.templateId}|${r.version}`;
    const planned = plans.get(id) ?? releaseMovePlan(ctx, r);
    plans.set(id, planned);
    return planned;
  };
  for (const row of rows) {
    try {
      const release = row.release;
      if (
        release &&
        ((params.templateId !== null && params.templateId !== release.templateId) ||
          (params.orgId !== null && params.orgId !== release.orgId) ||
          (params.mode !== undefined && params.mode !== release.mode) ||
          (params.version !== null && params.version !== release.version) ||
          (params.releaseId !== undefined && params.releaseId !== release.releaseId) ||
          (params.releaseGeneration !== undefined &&
            params.releaseGeneration !== release.generation))
      ) {
        throw new ConflictError(
          'The queued release changed. Start the rebuild again.',
          'TEMPLATE_RELEASE_CONFLICT',
        );
      }
      const move = release ? await movePlan(release) : null;
      const published = await publishPass(ctx, {
        orgScope: release
          ? { orgId: release.orgId, mode: release.mode, principal: 'session' }
          : params.mode
            ? { orgId: params.orgId, mode: params.mode, principal: 'session' }
            : params.orgId,
        passId: row.id,
        cause: params.cause === 'branding' ? 'admin' : params.cause,
        actor: { type: 'system', id: null },
        force: params.cause === 'resign',
        dispatch: false,
        // Each publish re-proves the starter in its own grant, so a revocation mid-page stops the next write.
        ...(params.principal
          ? {
              extraChecks: [reissuePrincipalCheck(params.orgId, params.principal, ctx.clock.now())],
            }
          : {}),
        ...(release
          ? { expectedRelease: { id: release.releaseId, generation: release.generation } }
          : {}),
        // Re-check the page's selectors after loading the pass in publish.
        mutate: (current) => {
          if (
            (params.templateId !== null && current.templateId !== params.templateId) ||
            (params.identityId && current.identityId !== params.identityId) ||
            (params.cause !== 'resign' && current.status !== 'active') ||
            (release &&
              (current.orgId !== release.orgId ||
                current.mode !== release.mode ||
                current.templateId !== release.templateId))
          ) {
            throw new ConflictError('The pass changed. Retry.', 'PASS_CONFLICT');
          }
          // Resigning and restyling keep each pass on its current template version.
          return release && move ? { templateVersion: release.version, ...move(current) } : {};
        },
      });
      if (published.changed) result.changed++;
      else result.unchanged++;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (
        params.principal &&
        !(await reissuePrincipalValid(ctx.env.DB, params.orgId, params.principal, ctx.clock.now()))
      ) {
        ctx.log.warn('bulk_reissue.principal_revoked', { code: 'REISSUE_PRINCIPAL_REVOKED' });
        result.revoked = true;
        break;
      }
      result.failed++;
      if (error.code === 'STAMPS_ABOVE_MAX') result.aboveMax = (result.aboveMax ?? 0) + 1;
      ctx.log.warn('bulk_reissue.pass_failed', {
        passId: row.id,
        templateId: params.templateId,
        code: error.code,
      });
      if (row.release)
        // Bookkeeping for the rollout view: it never fails the page.
        await recordRolloutFailure(ctx.env.DB, {
          passId: row.id,
          orgId: row.release.orgId,
          mode: row.release.mode,
          templateId: row.release.templateId,
          releaseId: row.release.releaseId,
          code: error.code,
          message: error.message,
          at: ctx.clock.now(),
        }).catch((cause: unknown) =>
          ctx.log.error('bulk_reissue.failure_record_failed', {
            passId: row.id,
            code: 'ROLLOUT_FAILURE_RECORD',
            error: cause,
          }),
        );
    }
  }
  if (result.revoked) {
    if (result.changed > 0) await dispatchSafely(ctx);
    return result;
  }
  if (rows.length === REISSUE_PAGE) result.nextCursor = rows[rows.length - 1]?.id ?? null;
  if (result.changed > 0) await dispatchSafely(ctx);
  return result;
}
