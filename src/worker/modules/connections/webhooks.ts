import type { UpstreamRecord } from '../../connectors/types.ts';
import type { NewConnectionWebhookJob } from '../../jobs/types.ts';
import { mintVerifiedWebhook, withVerifiedWebhook } from '../../jobs/webhook-ingress.ts';
import { classifyD1Error } from '../../platform/db.ts';
import {
  AppError,
  BadRequestError,
  NotFoundError,
  UnauthenticatedError,
  UnavailableError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getDeps } from './deps.ts';
import { captureConnectionRelease } from './records.ts';
import { getConnection } from './repo.ts';
import { classify, prepare } from './runtime.ts';
import { MAX_RECORDS_PER_STEP } from './sync.ts';
import { pinWebhookKeyContext } from './webhook-key-context.ts';
import { redispatchStagedWebhook } from './webhook-redispatch.ts';
import {
  completeRetainedDispatch,
  failRetainedEvent,
  stageRetainedWebhook,
} from './webhook-retention.ts';

/**
 * Verifies the signature, dedupes on the event id and queues the work. A duplicate delivery is
 * acknowledged without being processed again. Unknown, disabled and non-webhook connections look
 * identical to a missing one.
 */
export async function receiveWebhook(
  sctx: ServiceContext,
  connectionId: string,
  req: Request,
): Promise<void> {
  sctx = pinWebhookKeyContext(sctx);
  const conn = await getConnection(sctx.env.DB, connectionId);
  if (!conn?.enabled || (conn.mode !== 'webhook' && conn.mode !== 'hybrid')) {
    throw new NotFoundError('Not found.');
  }
  if (!(await isOrgActive(sctx, conn.orgId))) throw new NotFoundError('Not found.');
  let verified: {
    eventId: string;
    refs: string[];
    records?: Record<string, UpstreamRecord>;
    deleted?: string[];
  };
  let rawRequest: Request;
  try {
    rawRequest = req.clone();
    const prep = await prepare(sctx, conn);
    if (!prep.def.verifyWebhook) throw new NotFoundError('Not found.');
    verified = await prep.def.verifyWebhook(prep.cc, req);
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    const { code } = classify(error);
    if (code === 'AUTH') {
      throw new UnauthenticatedError('The webhook signature is invalid.', 'WEBHOOK_SIGNATURE');
    }
    if (code === 'INVALID_PAYLOAD')
      throw new BadRequestError('The webhook body is invalid.', 'WEBHOOK_PAYLOAD');
    sctx.log.warn('connection.webhook_unavailable', { connectionId, code });
    throw new NotFoundError('Not found.');
  }

  // The signature is verified: from here the connection stages its own work.
  sctx = withVerifiedWebhook(sctx, mintVerifiedWebhook(conn));
  let staged: 'fresh' | 'redispatch' | 'duplicate';
  let credentialKeysetCommitment: string;
  try {
    credentialKeysetCommitment = await ensureCredentialRefKeyset(sctx.env.DB, sctx.env);
    const release = await captureConnectionRelease(sctx, conn);
    const rawBody = new Uint8Array(await rawRequest.arrayBuffer());
    staged = await stageRetainedWebhook(
      sctx,
      conn,
      verified,
      release,
      rawBody,
      credentialKeysetCommitment,
    );
  } catch (error) {
    // Database and crypto errors can carry sender-controlled text: log only a stable code.
    sctx.log.error('connection.webhook_stage_failed', {
      connectionId,
      code: error instanceof AppError ? error.code : (classifyD1Error(error)?.kind ?? 'INTERNAL'),
    });
    throw new UnavailableError('Could not accept the webhook. Retry later.', 'WEBHOOK_UNAVAILABLE');
  }
  if (staged === 'redispatch') {
    await redispatchStagedWebhook(
      sctx,
      conn.orgId,
      conn.id,
      verified.eventId,
      credentialKeysetCommitment,
    );
    return;
  }
  if (staged === 'duplicate') {
    sctx.log.info('connection.webhook_duplicate', { connectionId });
    return;
  }
  try {
    // The retention layer uses the same chunk boundaries and preserves the original ref order.
    for (let i = 0; i < verified.refs.length || i === 0; i += MAX_RECORDS_PER_STEP) {
      const job: NewConnectionWebhookJob = {
        kind: 'connection.webhook',
        connectionId: conn.id,
        orgId: conn.orgId,
        generation: conn.generation,
        eventId: verified.eventId,
        refs: verified.refs.slice(i, i + MAX_RECORDS_PER_STEP),
        ...(i > 0 ? { chunk: i / MAX_RECORDS_PER_STEP } : {}),
        credentialKeysetCommitment,
      };
      await getDeps().enqueueJob(sctx, job);
    }
    await completeRetainedDispatch(
      sctx,
      conn.orgId,
      conn.id,
      verified.eventId,
      credentialKeysetCommitment,
    );
  } catch {
    try {
      await failRetainedEvent(
        sctx,
        conn.orgId,
        conn.id,
        verified.eventId,
        'WEBHOOK_ENQUEUE_FAILED',
        credentialKeysetCommitment,
      );
    } catch {
      sctx.log.error('connection.webhook_retention_failed', {
        connectionId,
        code: 'WEBHOOK_RETENTION_FAILED',
      });
      throw new UnavailableError(
        'Could not queue the webhook. Retry later.',
        'WEBHOOK_UNAVAILABLE',
      );
    }
    sctx.log.error('connection.webhook_enqueue_failed', {
      connectionId,
      code: 'WEBHOOK_ENQUEUE_FAILED',
    });
    throw new UnavailableError('Could not queue the webhook. Retry later.', 'WEBHOOK_UNAVAILABLE');
  }
}
