import type { JobOf, LegacyJob } from '../../jobs/types.ts';
import { AppError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { sealLegacyWebhookInbox } from './legacy-inbox.ts';
import type { ConnectionReleaseSnapshot } from './records.ts';
import { getConnection } from './repo.ts';
import type { InboxItem } from './repo-pass-inbox.ts';
import {
  hasStagedEvent,
  insertRetainedLegacy,
  markRetainedDeadLetter,
  type RetainedMode,
  type RetainedRow,
  retainedByChunk,
  setRetainedState,
  type WebhookReferenceMode,
} from './repo-webhook-retention.ts';
import { pinWebhookKeyContext } from './webhook-key-context.ts';
import { failUnprovenLegacyWebhook, rowFor } from './webhook-legacy-unproven.ts';
import { chunkHash, decryptRetainedPayload } from './webhook-payload.ts';
import { encryptedRow, referenceMode } from './webhook-stage-helpers.ts';

type WebhookJob = JobOf<'connection.webhook'>;

export const codeOf = (code: string) =>
  /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'WEBHOOK_FAILED';

export interface LoadedRetainedWebhook {
  state: RetainedRow['state'];
  items: InboxItem[];
  release: ConnectionReleaseSnapshot;
  connectionMode: RetainedMode;
  referenceMode: WebhookReferenceMode;
  source: RetainedRow['source'];
  revision: number;
  credentialKeysetCommitment: string | null;
}
export async function loadRetainedWebhook(
  sctx: ServiceContext,
  job: WebhookJob,
): Promise<LoadedRetainedWebhook | null> {
  sctx = pinWebhookKeyContext(sctx);
  const row = await rowFor(sctx, job);
  if (!row) {
    if (await hasStagedEvent(sctx.env.DB, job.connectionId, job.eventId)) {
      throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
    }
    return null;
  }
  const payload = await decryptRetainedPayload(sctx, row);
  const proof = row.credentialKeysetCommitment;
  if (
    proof !== null &&
    ((await requireCredentialRefKeyset(sctx.env.DB, sctx.env)) !== proof ||
      (job.credentialKeysetCommitment !== proof &&
        !(
          row.source === 'legacy' &&
          row.referenceMode === 'refs-only' &&
          job.credentialKeysetCommitment === undefined
        )))
  )
    throw new UnavailableError(
      'The webhook credential context is unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  if (proof === null && (row.source !== 'legacy' || job.credentialKeysetCommitment !== undefined)) {
    throw new UnavailableError(
      'The webhook credential context is unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  }
  return {
    state: row.state,
    items: payload.items,
    release: JSON.parse(row.releaseSnapshot) as ConnectionReleaseSnapshot,
    connectionMode: row.connectionMode,
    referenceMode: row.referenceMode,
    source: row.source,
    revision: row.revision,
    credentialKeysetCommitment: proof,
  };
}

/** Preserve a terminal reason without replaying a job that lost its connection authority. */
export async function ignoreRetainedWebhook(
  sctx: ServiceContext,
  job: WebhookJob,
  code: string,
  revision?: number,
): Promise<void> {
  const row = await retainedByChunk(
    sctx.env.DB,
    job.connectionId,
    job.eventId,
    await chunkHash(job.chunk, job.refs),
  );
  if (row) {
    if (
      row.orgId === job.orgId &&
      row.generation === job.generation &&
      (revision === undefined || row.revision === revision)
    ) {
      if (
        (row.source === 'ingress' &&
          (!row.credentialKeysetCommitment ||
            job.credentialKeysetCommitment !== row.credentialKeysetCommitment)) ||
        (row.source === 'legacy' &&
          job.credentialKeysetCommitment !== undefined &&
          job.credentialKeysetCommitment !== row.credentialKeysetCommitment)
      ) {
        throw new UnavailableError(
          'The webhook credential context is unavailable.',
          'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
        );
      }
      if (row.source === 'legacy' && row.credentialKeysetCommitment === null) {
        await failUnprovenLegacyWebhook(sctx, job, row.revision);
        return;
      }
      // A closed row (deleted connection, wiped envelope) has no payload left to verify.
      if (row.credentialKeysetCommitment !== null && row.state === 'pending')
        await loadRetainedWebhook(sctx, job);
      const changed = await setRetainedState(sctx, row, 'ignored', codeOf(code), sctx.clock.now());
      if (!changed) {
        const current = await retainedByChunk(
          sctx.env.DB,
          job.connectionId,
          job.eventId,
          await chunkHash(job.chunk, job.refs),
        );
        if (
          current &&
          current.orgId === job.orgId &&
          current.generation === job.generation &&
          current.state === 'pending' &&
          (revision === undefined || current.revision === revision)
        ) {
          throw new UnavailableError(
            'The webhook work changed. Retry later.',
            'WEBHOOK_WORK_CHANGED',
          );
        }
      }
    }
    return;
  }
  if (job.credentialKeysetCommitment !== undefined)
    throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
  if (await hasStagedEvent(sctx.env.DB, job.connectionId, job.eventId)) return;
  const conn = await getConnection(sctx.env.DB, job.connectionId);
  if (conn && conn.orgId !== job.orgId) return;
  let sealed: InboxItem[] = [];
  if (conn) {
    try {
      sealed = await sealLegacyWebhookInbox(sctx, job.connectionId, job.orgId, job.eventId);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'WEBHOOK_PAYLOAD_MISSING') throw error;
    }
  }
  const inbox = new Map(sealed.map((item) => [item.ref, item]));
  const legacy = await encryptedRow(sctx, {
    connectionId: job.connectionId,
    orgId: job.orgId,
    eventId: job.eventId,
    generation: job.generation,
    connectionMode: 'unknown',
    source: 'legacy',
    payload: {
      refs: job.refs,
      items: job.refs.map((ref) => inbox.get(ref) ?? { ref, record: null, deleted: false }),
      rawBody: null,
      credentialKeysetCommitment: null,
    },
    release: null,
    snapshotKnown: false,
    failure: codeOf(code),
  });
  legacy.state = 'ignored';
  await insertRetainedLegacy(sctx, legacy, false, null);
}

/** DLQ acknowledgement is allowed only after the chunk is durably recoverable and visible. */
export async function retainDeadLetterWebhook(
  sctx: ServiceContext,
  job: WebhookJob,
): Promise<void> {
  sctx = pinWebhookKeyContext(sctx);
  const conn = await getConnection(sctx.env.DB, job.connectionId);
  if (
    !conn?.enabled ||
    conn.orgId !== job.orgId ||
    conn.generation !== job.generation ||
    (conn.mode !== 'webhook' && conn.mode !== 'hybrid') ||
    !(await isOrgActive(sctx, job.orgId))
  ) {
    await ignoreRetainedWebhook(sctx, job, 'WEBHOOK_STALE_CONTEXT');
    return;
  }
  let row = await rowFor(sctx, job);
  if (row && row.connectionMode !== 'unknown' && row.connectionMode !== conn.mode) {
    await ignoreRetainedWebhook(sctx, job, 'WEBHOOK_STALE_CONTEXT', row.revision);
    return;
  }
  if (!row) {
    if (job.credentialKeysetCommitment !== undefined)
      throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
    if (await hasStagedEvent(sctx.env.DB, job.connectionId, job.eventId)) {
      throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
    }
    // Pre-upgrade jobs have no release snapshot. Seal everything still available, but never infer one.
    // The current connection was checked above; the original release remains unknown.
    let sealed: InboxItem[] = [];
    let mode: WebhookReferenceMode = 'unknown';
    if (conn?.orgId === job.orgId) {
      try {
        sealed = await sealLegacyWebhookInbox(sctx, job.connectionId, job.orgId, job.eventId);
        if (conn.generation === job.generation) mode = referenceMode(conn);
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          !['WEBHOOK_PAYLOAD_MISSING', 'WEBHOOK_REFERENCE_MODE'].includes(error.code)
        )
          throw error;
      }
    }
    const inbox = new Map(sealed.map((item) => [item.ref, item]));
    const missing =
      mode === 'unknown' ||
      (mode === 'embedded-required' && job.refs.some((ref) => !inbox.has(ref)));
    const legacy = await encryptedRow(sctx, {
      connectionId: job.connectionId,
      orgId: job.orgId,
      eventId: job.eventId,
      generation: job.generation,
      connectionMode: 'unknown',
      referenceMode: mode,
      source: 'legacy',
      payload: {
        refs: job.refs,
        items: job.refs.map((ref) => inbox.get(ref) ?? { ref, record: null, deleted: false }),
        rawBody: null,
        credentialKeysetCommitment: null,
      },
      release: null,
      snapshotKnown: false,
      failure: missing ? 'WEBHOOK_PAYLOAD_MISSING' : 'WEBHOOK_SNAPSHOT_UNAVAILABLE',
    });
    await insertRetainedLegacy(sctx, legacy, false, null);
    row = await rowFor(sctx, job);
    if (!row)
      throw new UnavailableError('Could not retain the webhook.', 'WEBHOOK_RETENTION_FAILED');
  }
  const unproven =
    row.source === 'legacy' &&
    row.credentialKeysetCommitment === null &&
    job.credentialKeysetCommitment === undefined;
  if (unproven) await failUnprovenLegacyWebhook(sctx, job, row.revision);
  // Verify payload and original proof before acknowledging, not at replay time.
  if (!(await loadRetainedWebhook(sctx, job))) {
    throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
  }
  if (row.errorCode === 'WEBHOOK_PAYLOAD_MISSING') {
    throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
  }
  if (unproven) return;
  if (!(await markRetainedDeadLetter(sctx, row, sctx.clock.now()))) {
    throw new UnavailableError('The webhook work changed. Retry later.', 'WEBHOOK_WORK_CHANGED');
  }
}

/**
 * A baseline-shaped queue message has no tenant binding and is never run. Bind it to the stored
 * connection and keep its sealed inbox as an ignored row; a deleted connection has nothing to keep.
 */
export async function retainLegacyQueuedWebhook(
  sctx: ServiceContext,
  legacy: Extract<LegacyJob, { kind: 'connection.webhook' }>,
): Promise<void> {
  sctx = pinWebhookKeyContext(sctx);
  const conn = await getConnection(sctx.env.DB, legacy.connectionId);
  if (!conn) return;
  await ignoreRetainedWebhook(
    sctx,
    {
      kind: 'connection.webhook',
      connectionId: conn.id,
      orgId: conn.orgId,
      generation: conn.generation,
      eventId: legacy.eventId,
      refs: legacy.refs,
    },
    'WEBHOOK_LEGACY_JOB',
  );
}
