import type { Mode } from '../../../shared/contracts/common.ts';
import { jobGrant } from '../../platform/authority.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import { tenantSql } from '../../platform/authority-cond.ts';
import { writePart } from '../../platform/authority-include.ts';
import { first } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { noPendingTransfer } from '../delivery/repo-delivery-checks.ts';
import type { BoundaryClaim } from './repo-boundaries.ts';

/** The pass lineage a render was worked out for; the commit refuses once any of it moved. */
export interface RenderLineage {
  orgId: string;
  mode: Mode;
  identityId: string;
  credentialGeneration: number;
  lifecycleGeneration: number;
  templateId: string;
  templateVersion: string;
  releaseId: string | null;
}

export interface NewRender {
  renderedAt: number;
  /** JSON of the timed keys. */
  render: string;
  dueAt: number | null;
  now: number;
}

/**
 * Stores a new render, takes its update tag (trigger) and queues a push, in one batch under a job grant:
 * the org is active, the pass is still live on this artifact and lineage, no transfer is pending, and the
 * claim still holds. A push already pending for the pass carries this one. 'stale' when the claim was
 * lost, 'refused' when the grant refused.
 */
export async function stampBoundary(
  ctx: ServiceContext,
  claim: BoundaryClaim,
  lineage: RenderLineage,
  next: NewRender,
  pushId: string,
): Promise<'stamped' | 'stale' | 'refused'> {
  const coalesceKey = `push:${JSON.stringify([
    claim.passId,
    lineage.identityId,
    lineage.credentialGeneration,
    lineage.lifecycleGeneration,
    lineage.templateId,
    lineage.templateVersion,
    lineage.releaseId,
  ])}`;
  const pending = await first(ctx.env.DB, 'SELECT 1 FROM outbox WHERE coalesce_key = ?', [
    coalesceKey,
  ]);
  try {
    return await commitStamp(ctx, claim, lineage, next, pushId, coalesceKey, !pending);
  } catch (error) {
    // Another writer queued the pass's push between the read and the insert: it announces this render too.
    if (!pending && error instanceof Error && COALESCE_RACE.test(error.message))
      return commitStamp(ctx, claim, lineage, next, pushId, coalesceKey, false);
    throw error;
  }
}

const COALESCE_RACE = /UNIQUE constraint failed: outbox\.coalesce_key/;

async function commitStamp(
  ctx: ServiceContext,
  claim: BoundaryClaim,
  lineage: RenderLineage,
  next: NewRender,
  pushId: string,
  coalesceKey: string,
  withPush: boolean,
): Promise<'stamped' | 'stale' | 'refused'> {
  const g = jobGrant(ctx, {
    job: 'boundary',
    purpose: 'org_mode.job.pass_boundary_render',
    orgId: lineage.orgId,
    mode: lineage.mode,
    target: claim.passId,
    tables: ['pass_boundaries', 'outbox'],
    checks: [
      rowIs('passes', claim.passId, {
        object_key: claim.objectKey,
        status: 'active',
        removed_at: null,
        deleted_at: null,
        test_data_quarantined: 0,
        identity_id: lineage.identityId,
        credential_generation: lineage.credentialGeneration,
        lifecycle_generation: lineage.lifecycleGeneration,
        template_id: lineage.templateId,
        template_version: lineage.templateVersion,
        release_id: lineage.releaseId,
      }),
      noPendingTransfer(claim.passId),
    ],
  });
  const [moved] = g.include(
    writePart(
      `UPDATE pass_boundaries SET rendered_at = ?, render = ?, stamped_at = ?, due_at = ?, attempts = 0
       WHERE pass_id IN (SELECT p.id FROM passes p WHERE p.id = ? AND p.org_id = {org} AND p.mode = {mode})
         AND object_key = ? AND due_at = ? AND {grant}
       RETURNING pass_id`,
      [
        next.renderedAt,
        next.render,
        next.now,
        next.dueAt,
        claim.passId,
        claim.objectKey,
        claim.lease,
      ],
    ),
  );
  if (withPush)
    g.insertSelect(
      'outbox',
      ['id', 'kind', 'pass_id', 'coalesce_key', 'payload', 'state', 'available_at', 'created_at'],
      [
        pushId,
        'push',
        claim.passId,
        coalesceKey,
        JSON.stringify({
          reason: 'refresh',
          identityId: lineage.identityId,
          templateId: lineage.templateId,
          templateVersion: lineage.templateVersion,
          releaseId: lineage.releaseId,
          credentialGeneration: lineage.credentialGeneration,
          lifecycleGeneration: lineage.lifecycleGeneration,
        }),
        'pending',
        0,
        next.now,
      ],
      {
        // Only with the render it announces: a lost claim queues nothing.
        when: [
          tenantSql(
            'EXISTS (SELECT 1 FROM pass_boundaries x WHERE x.pass_id = ? AND x.object_key = ? AND x.stamped_at = ?)',
            [claim.passId, claim.objectKey, next.now],
          ),
        ],
      },
    );
  try {
    const results = await g.commit();
    return moved !== undefined && (results[g.indexOf(moved)]?.results.length ?? 0) === 1
      ? 'stamped'
      : 'stale';
  } catch (error) {
    // The pass left this artifact or lineage, a transfer is pending, or the org stopped.
    if (error instanceof AppError) return 'refused';
    throw error;
  }
}
