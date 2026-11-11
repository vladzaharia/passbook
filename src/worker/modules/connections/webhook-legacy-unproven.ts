import type { JobOf } from '../../jobs/types.ts';
import { ConflictError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { parkUnprovenLegacyItems } from './repo-webhook-items.ts';
import { failUnprovenLegacyRetention } from './repo-webhook-legacy-unproven.ts';
import { type RetainedRow, retainedByChunk } from './repo-webhook-retention.ts';
import { chunkHash } from './webhook-payload.ts';

export async function rowFor(
  sctx: ServiceContext,
  job: JobOf<'connection.webhook'>,
): Promise<RetainedRow | null> {
  const row = await retainedByChunk(
    sctx.env.DB,
    job.connectionId,
    job.eventId,
    await chunkHash(job.chunk, job.refs),
  );
  if (row && (row.orgId !== job.orgId || row.generation !== job.generation)) {
    throw new ConflictError('The webhook context changed.', 'WEBHOOK_CONTEXT_CONFLICT');
  }
  return row;
}

/** Park old pending admissions before failing an unproven parent; never adopt a current key. */
export async function failUnprovenLegacyWebhook(
  sctx: ServiceContext,
  job: JobOf<'connection.webhook'>,
  revision: number,
): Promise<void> {
  const row = await rowFor(sctx, job);
  if (
    row?.source !== 'legacy' ||
    row.revision !== revision ||
    row.credentialKeysetCommitment !== null
  ) {
    throw new UnavailableError('The webhook work changed. Retry later.', 'WEBHOOK_WORK_CHANGED');
  }
  await parkUnprovenLegacyItems(sctx, row);
  if (row.state !== 'pending') return;
  if (!(await failUnprovenLegacyRetention(sctx, row, revision, sctx.clock.now()))) {
    throw new UnavailableError('The webhook work changed. Retry later.', 'WEBHOOK_WORK_CHANGED');
  }
}
