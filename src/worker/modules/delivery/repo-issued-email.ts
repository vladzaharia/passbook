import { type Check, rowIs } from '../../platform/authority-checks.ts';
import type { GrantCond } from '../../platform/authority-cond.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditEntry } from '../audit/types.ts';
import type { ConnectionEmailAuthority, ExpectedPassDelivery } from './binding.ts';
import { connectionCheck, issuanceLineageCheck, passLineageChecks } from './delivery-checks.ts';
import {
  addQueueWrites,
  commitQueue,
  type QueueActors,
  type QueueRate,
  type QueueResult,
  queueGrants,
  rateChecks,
  recordQueuedEvent,
} from './repo-email-queue.ts';

export interface IssuedEmailInput {
  pass: ExpectedPassDelivery;
  actors: QueueActors;
  connection?: ConnectionEmailAuthority;
  id: string;
  payload: Record<string, unknown>;
  now: number;
  rate: QueueRate;
  /** Only the owner of this durable issuance intent may consume it. */
  issuancePassId?: string;
  audit?: { entry: AuditEntry; when?: GrantCond[] };
}

/**
 * Queue against the issued pass in one batch under the caller's grant: the outbox row, both cap
 * counters, the event and the delivery row's move to `queued`. A lost lineage or exhausted cap
 * creates nothing and consumes no counter.
 */
export async function insertIssuedPassEmail(
  ctx: ServiceContext,
  input: IssuedEmailInput,
): Promise<QueueResult> {
  const { pass, connection } = input;
  if (pass.testDataQuarantined) return 'stale';
  if (
    connection &&
    (!connection.orgId ||
      !connection.connectionId ||
      !Number.isInteger(connection.generation) ||
      connection.generation < 1 ||
      connection.orgId !== pass.orgId ||
      pass.mode !== 'live' ||
      pass.status !== 'active' ||
      pass.removedAt !== null)
  )
    return 'stale';
  const checks: Check[] = [
    ...passLineageChecks(pass),
    ...(connection
      ? [
          rowIs('passes', pass.id, {
            connection_id: connection.connectionId,
            external_ref: connection.externalRef,
          }),
          connectionCheck(connection),
        ]
      : []),
    ...(input.issuancePassId ? [issuanceLineageCheck(input.issuancePassId)] : []),
    ...rateChecks(input.rate),
  ];
  const grants = queueGrants(ctx, input.actors, {
    orgId: pass.orgId,
    mode: pass.mode,
    checks,
    target: pass.id,
  });
  const primary = grants[0];
  if (!primary) return 'denied';
  addQueueWrites(primary, ctx, {
    id: input.id,
    passId: pass.id,
    payload: input.payload,
    now: input.now,
    rate: input.rate,
    ...(input.audit ? { audit: input.audit } : {}),
  });
  if (input.issuancePassId)
    primary.update('pass_issuance_deliveries', {
      set: { state: 'queued', outbox_id: input.id, error_code: null },
      where: { pass_id: input.issuancePassId, state: 'pending', outbox_id: null },
      require: 'one',
      returning: ['pass_id'],
    });
  const result = await commitQueue(ctx, grants);
  if (result === 'queued')
    await recordQueuedEvent(ctx, input.actors, {
      orgId: pass.orgId,
      mode: pass.mode,
      passId: pass.id,
      outboxId: input.id,
      data: { attached: input.payload.attach === true },
    });
  return result;
}
