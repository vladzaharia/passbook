import { rawCheck } from '../../platform/authority-checks.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { commitOrNull, connectionGrant, retentionIs, rowCount } from './repo-grants.ts';
import type { RetainedRow, RetentionState } from './repo-webhook-retention.ts';

export async function setRetainedState(
  ctx: ServiceContext,
  row: RetainedRow,
  state: RetentionState,
  code: string | null,
  now: number,
): Promise<boolean> {
  // Only an ignored chunk may leave a keyset-less (legacy) row; every other state needs its commitment.
  if (state !== 'ignored' && row.credentialKeysetCommitment === null) return false;
  const actor = { orgId: row.orgId };
  // Ignoring finishes stale work, which must work while the org is suspended: a closing grant names the org.
  const closing = state === 'ignored';
  const org = closing ? { org_id: row.orgId } : {};
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.state',
    [
      retentionIs(row.id, {
        generation: row.generation,
        state: 'pending',
        revision: row.revision,
        ...org,
      }),
      ...(state === 'resolved'
        ? [
            rawCheck(
              'retention',
              "NOT EXISTS (SELECT 1 FROM connection_webhook_items i WHERE i.retention_id = ? AND i.state <> 'success')",
              [row.id],
            ),
          ]
        : []),
    ],
    row.id,
    closing,
  );
  g.update('connection_webhook_retention', {
    set: { state, error_code: code, updated_at: now },
    inc: ['revision'],
    where: {
      id: row.id,
      ...org,
      generation: row.generation,
      state: 'pending',
      revision: row.revision,
      ...(state === 'ignored'
        ? {}
        : { credential_keyset_commitment: row.credentialKeysetCommitment }),
    },
    returning: ['id'],
  });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results.at(-1)) === 1 : false;
}

/** In-flight children at DLQ are indeterminate, never implicitly safe to replay. */
export async function markRetainedDeadLetter(
  ctx: ServiceContext,
  row: RetainedRow,
  now: number,
): Promise<boolean> {
  const proof = row.credentialKeysetCommitment;
  if (proof === null ? row.source !== 'legacy' : !/^[0-9a-f]{64}$/.test(proof)) return false;
  const actor = { orgId: row.orgId };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.dead_letter',
    [
      retentionIs(row.id, {
        generation: row.generation,
        revision: row.revision,
        source: row.source,
        state: row.state,
        credential_keyset_commitment: proof,
      }),
    ],
    row.id,
  );
  g.joined('connection_webhook_items', {
    set: { state: 'uncertain', token: null, error_code: 'WEBHOOK_EFFECT_UNCERTAIN' },
    where: { retention_id: row.id, state: 'started' },
  });
  if (row.state === 'pending')
    g.update('connection_webhook_retention', {
      set: { state: 'failed', error_code: 'WEBHOOK_DEAD_LETTER', updated_at: now },
      inc: ['revision'],
      where: { id: row.id, revision: row.revision, source: row.source, state: 'pending' },
      returning: ['id'],
    });
  const results = await commitOrNull(g, actor);
  return results !== null && (row.state !== 'pending' || rowCount(results.at(-1)) === 1);
}

export async function failPendingEvent(
  ctx: ServiceContext,
  orgId: string,
  connectionId: string,
  eventId: string,
  code: string,
  now: number,
  credentialKeysetCommitment: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(credentialKeysetCommitment)) return;
  const actor = { orgId };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.fail_event',
    [
      rawCheck(
        'retention',
        `NOT EXISTS (SELECT 1 FROM connection_webhook_retention r
          WHERE r.connection_id = ? AND r.event_id = ? AND r.source = 'ingress'
            AND r.credential_keyset_commitment IS NOT ?)`,
        [connectionId, eventId, credentialKeysetCommitment],
      ),
    ],
    eventId,
  );
  g.update('connection_webhook_retention', {
    set: { state: 'failed', error_code: code, updated_at: now },
    inc: ['revision'],
    where: {
      connection_id: connectionId,
      event_id: eventId,
      source: 'ingress',
      state: 'pending',
      credential_keyset_commitment: credentialKeysetCommitment,
    },
  });
  await commitOrNull(g, actor);
}
