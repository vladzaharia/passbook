import type { UpstreamRecord } from '../../connectors/types.ts';
import type { JobOf } from '../../jobs/types.ts';
import {
  BadRequestError,
  NotFoundError,
  UnauthenticatedError,
  UnavailableError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getDeps } from './deps.ts';
import { closeRun } from './health.ts';
import { emptyTotals } from './records.ts';
import { getConnection } from './repo.ts';
import {
  deleteWebhookEvent,
  getInbox,
  type InboxItem,
  insertInbox,
  insertWebhookEvent,
} from './repo-passes.ts';
import { insertRun } from './repo-runs.ts';
import { classify, prepare } from './runtime.ts';
import { applyChanges } from './sync.ts';

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
  const conn = await getConnection(sctx.env.DB, connectionId);
  if (!conn?.enabled || (conn.mode !== 'webhook' && conn.mode !== 'hybrid')) {
    throw new NotFoundError('Not found.');
  }
  let verified: {
    eventId: string;
    refs: string[];
    records?: Record<string, UpstreamRecord>;
    deleted?: string[];
  };
  try {
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

  const now = sctx.clock.now();
  const fresh = await insertWebhookEvent(sctx.env.DB, conn.id, verified.eventId, now);
  if (!fresh) {
    sctx.log.info('connection.webhook_duplicate', { connectionId });
    return;
  }
  const items: InboxItem[] = verified.refs
    .filter((ref) => verified.records?.[ref] || verified.deleted?.includes(ref))
    .map((ref) => ({
      ref,
      record: verified.records?.[ref] ?? null,
      deleted: verified.deleted?.includes(ref) ?? false,
    }));
  try {
    await insertInbox(sctx.env.DB, conn.id, verified.eventId, items, now);
    await getDeps().enqueueJob(sctx, {
      kind: 'connection.webhook',
      connectionId: conn.id,
      eventId: verified.eventId,
      refs: verified.refs,
    });
  } catch (error) {
    // Let the sender's retry through instead of losing the event.
    await deleteWebhookEvent(sctx.env.DB, conn.id, verified.eventId);
    sctx.log.error('connection.webhook_enqueue_failed', { connectionId, error });
    throw new UnavailableError('Could not queue the webhook. Retry later.', 'WEBHOOK_UNAVAILABLE');
  }
}

/** Applies the refs named by one webhook: inbox records directly, bare refs via fetchRecord. */
export async function processWebhook(
  sctx: ServiceContext,
  job: JobOf<'connection.webhook'>,
): Promise<void> {
  const conn = await getConnection(sctx.env.DB, job.connectionId);
  if (!conn?.enabled) return;
  const runId = sctx.ids.id();
  const startedAt = sctx.clock.now();
  await insertRun(sctx.env.DB, { id: runId, connectionId: conn.id, trigger: 'webhook', startedAt });
  const base = { runId, instanceId: null, generation: conn.generation, startedAt, stale: false };
  let prep: Awaited<ReturnType<typeof prepare>>;
  try {
    prep = await prepare(sctx, conn);
  } catch (error) {
    await closeRun(
      sctx,
      conn.id,
      { ...base, totals: emptyTotals(), failure: classify(error) },
      { countsForBreaker: true },
    );
    return;
  }
  const inbox = new Map((await getInbox(sctx.env.DB, conn.id, job.eventId)).map((i) => [i.ref, i]));
  const changes = job.refs.map((ref) => {
    const item = inbox.get(ref);
    return {
      ref,
      deleted: item?.deleted ?? false,
      record: (item?.record ?? undefined) as UpstreamRecord | undefined,
    };
  });
  const { totals, failure } = await applyChanges(sctx, conn, prep, changes);
  await closeRun(sctx, conn.id, { ...base, totals, failure }, { countsForBreaker: true });
}
