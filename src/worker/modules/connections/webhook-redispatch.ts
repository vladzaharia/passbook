import type { NewConnectionWebhookJob } from '../../jobs/types.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { AppError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getDeps } from './deps.ts';
import { getConnection } from './repo.ts';
import {
  parkStalledReplay,
  reopenEnqueueFailed,
  retainedIngressChunks,
  stalledReplays,
  undispatchedEvents,
} from './repo-webhook-retention.ts';
import { pinWebhookKeyContext } from './webhook-key-context.ts';
import { decryptRetainedPayload } from './webhook-payload.ts';
import { completeRetainedDispatch, failRetainedEvent } from './webhook-retention.ts';

/** A chunk this old without a completed dispatch is not an in-flight request. */
const UNDISPATCHED_AFTER_MS = 5 * 60_000;
const SWEEP_BATCH = 10;

const stableCode = (error: unknown): string =>
  error instanceof AppError ? error.code : (classifyD1Error(error)?.kind ?? 'INTERNAL');

/**
 * Enqueue the stored chunks of an event whose first dispatch failed or never finished, then mark
 * it complete. Item claims make a job that is queued twice idempotent. A failure re-marks the
 * event failed, so the provider's next retry (or the sweep) tries again.
 */
export async function redispatchStagedWebhook(
  sctx: ServiceContext,
  orgId: string,
  connectionId: string,
  eventId: string,
  credentialKeysetCommitment: string,
): Promise<void> {
  sctx = pinWebhookKeyContext(sctx);
  try {
    await reopenEnqueueFailed(
      sctx,
      orgId,
      connectionId,
      eventId,
      sctx.clock.now(),
      credentialKeysetCommitment,
    );
    const chunks = await retainedIngressChunks(sctx.env.DB, connectionId, eventId);
    const first = chunks[0];
    if (
      !first ||
      chunks.length !== first.chunkCount ||
      chunks.some((c) => c.credentialKeysetCommitment !== credentialKeysetCommitment)
    ) {
      throw new UnavailableError(
        'Webhook dispatch is incomplete. Retry later.',
        'WEBHOOK_DISPATCH_INCOMPLETE',
      );
    }
    for (const chunk of chunks) {
      if (chunk.state !== 'pending') continue;
      const payload = await decryptRetainedPayload(sctx, chunk);
      const job: NewConnectionWebhookJob = {
        kind: 'connection.webhook',
        connectionId: chunk.connectionId,
        orgId: chunk.orgId,
        generation: chunk.generation,
        eventId: chunk.eventId,
        refs: payload.refs,
        ...(payload.chunk ? { chunk: payload.chunk } : {}),
        credentialKeysetCommitment,
      };
      await getDeps().enqueueJob(sctx, job);
    }
    await completeRetainedDispatch(sctx, orgId, connectionId, eventId, credentialKeysetCommitment);
    sctx.log.info('connection.webhook_redispatched', { connectionId, chunks: chunks.length });
  } catch (error) {
    sctx.log.error('connection.webhook_redispatch_failed', {
      connectionId,
      code: stableCode(error),
    });
    // A lost payload cannot be dispatched by retrying; everything else stays sweepable.
    const code =
      error instanceof AppError && error.code === 'WEBHOOK_PAYLOAD_MISSING'
        ? error.code
        : 'WEBHOOK_ENQUEUE_FAILED';
    try {
      await failRetainedEvent(sctx, orgId, connectionId, eventId, code, credentialKeysetCommitment);
    } catch (markError) {
      sctx.log.error('connection.webhook_retention_failed', {
        connectionId,
        code: stableCode(markError),
      });
    }
    throw error instanceof UnavailableError
      ? error
      : new UnavailableError('Could not queue the webhook. Retry later.', 'WEBHOOK_UNAVAILABLE');
  }
}

/**
 * Cron: finish dispatch for events the provider did not retry. A failure on one event is logged
 * and does not stop the rest.
 */
export async function sweepUndispatchedWebhooks(sctx: ServiceContext): Promise<number> {
  const events = await undispatchedEvents(
    sctx.env.DB,
    sctx.clock.now() - UNDISPATCHED_AFTER_MS,
    SWEEP_BATCH,
  );
  let done = 0;
  for (const event of events) {
    const conn = await getConnection(sctx.env.DB, event.connectionId);
    if (!conn?.enabled) continue;
    try {
      await redispatchStagedWebhook(
        sctx,
        event.orgId,
        event.connectionId,
        event.eventId,
        event.credentialKeysetCommitment,
      );
      done++;
    } catch (error) {
      // redispatchStagedWebhook already logged the failure and re-marked the event.
      sctx.log.warn('connection.webhook_sweep_skipped', {
        connectionId: event.connectionId,
        code: stableCode(error),
      });
    }
  }
  return done;
}

/** Past the queue's retry horizon (about 2 h to the dead letter). */
const STALLED_REPLAY_AFTER_MS = 3 * 60 * 60_000;

/**
 * Cron: a replay whose enqueue (or the restore after a failed one) was lost stays `pending` with its
 * dispatch complete. After a bounded age it is parked as uncertain so the recovery panel shows it.
 */
export async function sweepStalledReplays(sctx: ServiceContext): Promise<number> {
  const now = sctx.clock.now();
  const rows = await stalledReplays(sctx.env.DB, now - STALLED_REPLAY_AFTER_MS, SWEEP_BATCH);
  let parked = 0;
  for (const row of rows) {
    if (await parkStalledReplay(sctx, row, now)) {
      parked++;
      sctx.log.warn('connection.webhook_replay_stalled', {
        code: 'WEBHOOK_REPLAY_STALLED',
        retentionId: row.id,
      });
    }
  }
  return parked;
}
