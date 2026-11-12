import type { UpstreamRecord } from '../../connectors/types.ts';
import type { JobOf } from '../../jobs/types.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, UnavailableError } from '../../platform/errors.ts';
import { toBase64 } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { syncKeysetCurrent } from './keyset-current.ts';
import { retainLegacyDuplicate } from './legacy-duplicate.ts';
import type { ConnectionReleaseSnapshot } from './records.ts';
import type { ConnectionRow } from './repo.ts';
import {
  completeDispatch,
  failPendingEvent,
  hasStagedEvent,
  hasUncertainDispatch,
  insertStagedWebhook,
  type RetainedRow,
  setRetainedState,
} from './repo-webhook-retention.ts';
import { MAX_RECORDS_PER_STEP } from './sync.ts';
import { pinWebhookKeyContext } from './webhook-key-context.ts';
import { rowFor } from './webhook-legacy-unproven.ts';
import { codeOf } from './webhook-retention-recovery.ts';
import { encryptedRow, itemsFor, referenceMode } from './webhook-stage-helpers.ts';

export {
  ignoreRetainedWebhook,
  type LoadedRetainedWebhook,
  loadRetainedWebhook,
  retainDeadLetterWebhook,
  retainLegacyQueuedWebhook,
} from './webhook-retention-recovery.ts';

type WebhookJob = JobOf<'connection.webhook'>;
type Verified = {
  eventId: string;
  refs: string[];
  records?: Record<string, UpstreamRecord>;
  deleted?: string[];
};

/**
 * Store the signed bytes and all parsed chunks before acknowledging ingress or enqueueing.
 * `fresh` is dispatched by the caller; `redispatch` is a retry of an event that never finished.
 */
export async function stageRetainedWebhook(
  sctx: ServiceContext,
  conn: ConnectionRow,
  verified: Verified,
  release: ConnectionReleaseSnapshot,
  rawBody: Uint8Array,
  credentialKeysetCommitment: string,
): Promise<'fresh' | 'redispatch' | 'duplicate'> {
  sctx = pinWebhookKeyContext(sctx);
  if (
    typeof credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(credentialKeysetCommitment) ||
    (await requireCredentialRefKeyset(sctx.env.DB, sctx.env)) !== credentialKeysetCommitment
  ) {
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  }
  if (conn.mode !== 'webhook' && conn.mode !== 'hybrid') {
    throw new ConflictError('The connection changed. Retry the webhook.', 'CONNECTION_CONFLICT');
  }
  const mode = referenceMode(conn);
  if (
    mode === 'embedded-required' &&
    verified.refs.some((ref) => !verified.records?.[ref] && !verified.deleted?.includes(ref))
  ) {
    throw new UnavailableError('The webhook payload is incomplete.', 'WEBHOOK_PAYLOAD_MISSING');
  }
  const body = toBase64(rawBody);
  const rows: RetainedRow[] = [];
  for (let i = 0; i < verified.refs.length || i === 0; i += MAX_RECORDS_PER_STEP) {
    const refs = verified.refs.slice(i, i + MAX_RECORDS_PER_STEP);
    rows.push(
      await encryptedRow(sctx, {
        connectionId: conn.id,
        orgId: conn.orgId,
        eventId: verified.eventId,
        generation: conn.generation,
        connectionMode: conn.mode,
        referenceMode: mode,
        source: 'ingress',
        payload: {
          refs,
          items: itemsFor(refs, verified.records, verified.deleted),
          rawBody: i === 0 ? body : null,
          credentialKeysetCommitment,
          ...(i > 0 ? { chunk: i / MAX_RECORDS_PER_STEP } : {}),
        },
        release,
        snapshotKnown: true,
        chunkCount: Math.max(1, Math.ceil(verified.refs.length / MAX_RECORDS_PER_STEP)),
      }),
    );
  }
  try {
    if (!(await insertStagedWebhook(sctx, rows))) {
      throw new ConflictError('The connection changed. Retry the webhook.', 'CONNECTION_CONFLICT');
    }
  } catch (error) {
    if (classifyD1Error(error)?.kind === 'unique') {
      if (await hasStagedEvent(sctx.env.DB, conn.id, verified.eventId)) {
        // Staged but never fully dispatched: the provider's retry dispatches it again.
        return (await hasUncertainDispatch(sctx.env.DB, conn.id, verified.eventId))
          ? 'redispatch'
          : 'duplicate';
      }
      await retainLegacyDuplicate(sctx, conn, verified, rawBody, mode, credentialKeysetCommitment);
      return 'duplicate';
    }
    throw error;
  }
  return 'fresh';
}

async function transitionRetainedWebhook(
  sctx: ServiceContext,
  job: WebhookJob,
  revision: number,
  state: 'failed' | 'blocked' | 'resolved',
  code: string | null,
): Promise<void> {
  const row = await rowFor(sctx, job);
  if (!row)
    throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
  if (row.state !== 'pending') return;
  if (
    row.revision === revision &&
    (await syncKeysetCurrent(sctx, row.credentialKeysetCommitment ?? undefined)) &&
    (await setRetainedState(sctx, row, state, code, sctx.clock.now()))
  )
    return;
  const current = await rowFor(sctx, job);
  if (current && current.state !== 'pending') return;
  throw new UnavailableError('The webhook work changed. Retry later.', 'WEBHOOK_WORK_CHANGED');
}

export async function failRetainedWebhook(
  sctx: ServiceContext,
  job: WebhookJob,
  code: string,
  revision: number,
): Promise<void> {
  const safeCode = codeOf(code);
  const state =
    safeCode === 'TEMPLATE_RELEASE_REQUIRED' || safeCode === 'TEMPLATE_RELEASE_CONFLICT'
      ? 'blocked'
      : 'failed';
  await transitionRetainedWebhook(sctx, job, revision, state, safeCode);
}

export async function resolveRetainedWebhook(
  sctx: ServiceContext,
  job: WebhookJob,
  revision: number,
): Promise<void> {
  await transitionRetainedWebhook(sctx, job, revision, 'resolved', null);
}

export async function failRetainedEvent(
  sctx: ServiceContext,
  orgId: string,
  connectionId: string,
  eventId: string,
  code: string,
  credentialKeysetCommitment: string,
): Promise<void> {
  if (!(await syncKeysetCurrent(sctx, credentialKeysetCommitment))) return;
  await failPendingEvent(
    sctx,
    orgId,
    connectionId,
    eventId,
    codeOf(code),
    sctx.clock.now(),
    credentialKeysetCommitment,
  );
}

/** Marks all enqueues complete before ingress can report success. */
export async function completeRetainedDispatch(
  sctx: ServiceContext,
  orgId: string,
  connectionId: string,
  eventId: string,
  credentialKeysetCommitment: string,
): Promise<void> {
  if (
    !(await syncKeysetCurrent(sctx, credentialKeysetCommitment)) ||
    !(await completeDispatch(sctx, orgId, connectionId, eventId, credentialKeysetCommitment))
  ) {
    throw new UnavailableError(
      'Webhook dispatch is incomplete. Retry later.',
      'WEBHOOK_DISPATCH_INCOMPLETE',
    );
  }
}
