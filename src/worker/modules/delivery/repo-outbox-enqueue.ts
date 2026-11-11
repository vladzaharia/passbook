import type { Mode } from '../../../shared/contracts/common.ts';
import { jobGrant } from '../../platform/authority.ts';
import { rowIs } from '../../platform/authority-checks.ts';
import { first } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sanitizeEventData } from '../events/record.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { DELIVERY_CODES } from './delivery-actor.ts';
import { noPendingTransfer } from './delivery-checks.ts';

export interface NewOutbox {
  id: string;
  orgId: string;
  kind: 'push' | 'email';
  passId: string;
  coalesceKey: string | null;
  payload: Record<string, unknown>;
  now: number;
}

/**
 * Queues a push for the pass incarnation it names, under a job grant: the org is active and the
 * pass is in that identity, generations, template and release with no transfer pending. A push
 * already pending under the same coalescing key reads 'coalesced'; a lost lineage reads 'stale'.
 */
export async function insertPushOutbox(
  ctx: ServiceContext,
  row: Omit<NewOutbox, 'kind'> & {
    mode: Mode;
    identityId: string;
    credentialGeneration: number;
    lifecycleGeneration: number;
    templateId: string;
    templateVersion: string;
    releaseId: string | null;
  },
): Promise<'inserted' | 'coalesced' | 'stale'> {
  if (
    row.coalesceKey !== null &&
    (await first(ctx.env.DB, 'SELECT 1 FROM outbox WHERE coalesce_key = ?', [row.coalesceKey]))
  )
    return (await pushLineageHolds(ctx, row)) ? 'coalesced' : 'stale';
  const g = jobGrant(ctx, {
    job: 'push',
    purpose: 'org_mode.job.push_enqueue',
    orgId: row.orgId,
    mode: row.mode,
    target: row.passId,
    codes: DELIVERY_CODES,
    checks: [pushLineage(row), noPendingTransfer(row.passId)],
  });
  g.insertSelect(
    'outbox',
    ['id', 'kind', 'pass_id', 'coalesce_key', 'payload', 'state', 'available_at', 'created_at'],
    [
      row.id,
      'push',
      row.passId,
      row.coalesceKey,
      JSON.stringify(row.payload),
      'pending',
      0,
      row.now,
    ],
  );
  try {
    await g.commit();
    return 'inserted';
  } catch (error) {
    if (error instanceof AppError) return 'stale';
    // Another writer took the coalescing key between our read and the insert.
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: outbox\.coalesce_key/.test(error.message)
    )
      return 'coalesced';
    throw error;
  }
}

type PushLineage = Parameters<typeof insertPushOutbox>[1];

const pushLineage = (row: PushLineage) =>
  rowIs('passes', row.passId, {
    identity_id: row.identityId,
    credential_generation: row.credentialGeneration,
    lifecycle_generation: row.lifecycleGeneration,
    template_id: row.templateId,
    template_version: row.templateVersion,
    release_id: row.releaseId,
    deleted_at: null,
    test_data_quarantined: 0,
  });

/** A read-only run of the same grant checks, to tell a coalesced push from an unavailable pass. */
async function pushLineageHolds(ctx: ServiceContext, row: PushLineage): Promise<boolean> {
  const g = jobGrant(ctx, {
    job: 'push',
    purpose: 'org_mode.job.push_enqueue',
    orgId: row.orgId,
    mode: row.mode,
    target: row.passId,
    codes: DELIVERY_CODES,
    checks: [pushLineage(row), noPendingTransfer(row.passId)],
  });
  try {
    await g.commit();
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}

/** Ledger entries never describe a queued push under a later credential incarnation. */
export async function recordPushQueuedEvent(
  ctx: ServiceContext,
  snapshot: {
    passId: string;
    orgId: string;
    mode: Mode;
    identityId: string;
    credentialGeneration: number;
    lifecycleGeneration: number;
    templateId: string;
    templateVersion: string;
    releaseId: string | null;
    passVersion: number;
    reason: 'publish' | 'refresh';
    credentialKeysetCommitment?: string;
  },
): Promise<void> {
  const now = ctx.clock.now();
  try {
    if (
      snapshot.credentialKeysetCommitment !== undefined &&
      (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !==
        snapshot.credentialKeysetCommitment
    )
      return;
    const g = jobGrant(ctx, {
      job: 'push',
      purpose: 'org_mode.job.push_event',
      orgId: snapshot.orgId,
      mode: snapshot.mode,
      target: snapshot.passId,
      codes: DELIVERY_CODES,
      checks: [
        rowIs('passes', snapshot.passId, {
          identity_id: snapshot.identityId,
          credential_generation: snapshot.credentialGeneration,
          lifecycle_generation: snapshot.lifecycleGeneration,
          template_id: snapshot.templateId,
          template_version: snapshot.templateVersion,
          release_id: snapshot.releaseId,
          version: snapshot.passVersion,
          deleted_at: null,
          test_data_quarantined: 0,
        }),
        noPendingTransfer(snapshot.passId),
      ],
    });
    g.insertSelect(
      'pass_events',
      ['id', 'pass_id', 'kind', 'device', 'actor_type', 'actor_id', 'data', 'at'],
      [
        ctx.ids.ordered(now),
        snapshot.passId,
        'push.queued',
        null,
        null,
        null,
        JSON.stringify(
          sanitizeEventData({ version: snapshot.passVersion, reason: snapshot.reason }),
        ),
        now,
      ],
    );
    await g.commit();
  } catch (error) {
    // A lost lineage means the push no longer describes the pass: no event, by design.
    if (error instanceof AppError) return;
    ctx.log.error('events.record_failed', {
      code: 'EVENT_RECORD_FAILED',
      count: 1,
      kind: 'push.queued',
      passId: snapshot.passId,
      error,
    });
  }
}
