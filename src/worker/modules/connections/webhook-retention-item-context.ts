import type { JobOf } from '../../jobs/types.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { itemState } from './repo-webhook-items.ts';
import { type RetainedRow, retainedByChunk } from './repo-webhook-retention.ts';
import { chunkHash } from './webhook-payload.ts';

type WebhookJob = JobOf<'connection.webhook'>;

export async function pendingRow(
  sctx: ServiceContext,
  job: WebhookJob,
  revision: number,
): Promise<RetainedRow> {
  const row = await retainedByChunk(
    sctx.env.DB,
    job.connectionId,
    job.eventId,
    await chunkHash(job.chunk, job.refs),
  );
  if (
    !row ||
    row.orgId !== job.orgId ||
    row.generation !== job.generation ||
    row.state !== 'pending' ||
    row.revision !== revision ||
    !row.credentialKeysetCommitment ||
    (row.source === 'ingress' &&
      job.credentialKeysetCommitment !== row.credentialKeysetCommitment) ||
    (row.source === 'legacy' &&
      job.credentialKeysetCommitment !== undefined &&
      job.credentialKeysetCommitment !== row.credentialKeysetCommitment)
  ) {
    throw new UnavailableError('The webhook work changed. Retry later.', 'WEBHOOK_WORK_CHANGED');
  }
  return row;
}

export async function unavailableOrTerminal(
  sctx: ServiceContext,
  row: RetainedRow,
  ordinal: number,
): Promise<null> {
  const state = await itemState(sctx.env.DB, row.id, ordinal);
  if (state === 'success' || state === 'blocked' || state === 'failed' || state === 'uncertain')
    return null;
  if (state === 'started')
    throw new UnavailableError('The webhook item is already running.', 'WEBHOOK_ITEM_BUSY');
  throw new UnavailableError('The webhook work changed. Retry later.', 'WEBHOOK_WORK_CHANGED');
}
