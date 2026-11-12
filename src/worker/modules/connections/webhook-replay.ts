import { connectors } from '../../connectors/registry.ts';
import type { NewConnectionWebhookJob } from '../../jobs/types.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnavailableError,
} from '../../platform/errors.ts';
import { toHex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import {
  captureCredentialKeyEnv,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { assertConnectionAuthority, type ConnectionAuthority } from './access.ts';
import { getDeps } from './deps.ts';
import { syncKeysetCurrent } from './keyset-current.ts';
import { type ConnectionReleaseSnapshot, captureConnectionRelease } from './records.ts';
import { getConnection } from './repo.ts';
import { summarizeItems } from './repo-webhook-items.ts';
import { reserveReplay, restoreFailedReplay } from './repo-webhook-replay.ts';
import { listRetained, retainedById } from './repo-webhook-retention.ts';
import { pinWebhookKeyContext } from './webhook-key-context.ts';
import { decryptRetainedPayload } from './webhook-payload.ts';

/** Only metadata leaves the service; event IDs and refs are sender-controlled. */
export async function listRetainedWebhooks(sctx: ServiceContext, connectionId: string) {
  const keyEnv = captureCredentialKeyEnv(sctx.env);
  await requireCredentialRefKeyset(sctx.env.DB, keyEnv);
  const rows = await listRetained(sctx.env.DB, connectionId);
  const key = await derivedHmacKey(keyEnv, 'connection.webhook.event-ref.v1');
  const encoder = new TextEncoder();
  return {
    items: await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        eventRef: toHex(
          new Uint8Array(
            await crypto.subtle.sign(
              'HMAC',
              key,
              encoder.encode(JSON.stringify([row.connectionId, row.eventId])) as BufferSource,
            ),
          ),
        ),
        generation: row.generation,
        connectionMode: row.connectionMode,
        state: row.state,
        errorCode: row.errorCode,
        uncertainItems: row.uncertainItems,
        receivedAt: row.receivedAt,
        updatedAt: row.updatedAt,
      })),
    ),
  };
}

function sameRelease(a: ConnectionReleaseSnapshot, b: ConnectionReleaseSnapshot): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'approved' && b.kind === 'approved') {
    return a.id === b.id && a.generation === b.generation && a.version === b.version;
  }
  return a.kind === 'blocked' && b.kind === 'blocked' && a.code === b.code;
}

/** Select only proven, unprocessed ordinals; a rebind is explicit, audited and generation-fenced. */
export async function replayRetainedWebhook(
  sctx: ServiceContext,
  connectionId: string,
  id: string,
  authority: ConnectionAuthority,
): Promise<void> {
  sctx = pinWebhookKeyContext(sctx);
  const row = await retainedById(sctx.env.DB, connectionId, id);
  if (!row) throw new NotFoundError('Webhook work not found.', 'WEBHOOK_NOT_FOUND');
  if (authority.orgId !== row.orgId || authority.mode !== 'live') throw new ForbiddenError();
  await assertConnectionAuthority(sctx, authority);
  if (row.state === 'resolved' || row.state === 'ignored') {
    throw new ConflictError('This webhook work is already finished.', 'WEBHOOK_ALREADY_FINISHED');
  }
  if (!row.snapshotKnown || row.connectionMode === 'unknown') {
    throw new ConflictError(
      'The original webhook context is unavailable.',
      'WEBHOOK_SNAPSHOT_UNAVAILABLE',
    );
  }
  const proof = row.credentialKeysetCommitment;
  if (
    !proof ||
    !/^[0-9a-f]{64}$/.test(proof) ||
    (row.source !== 'ingress' && !(row.source === 'legacy' && row.referenceMode === 'refs-only'))
  ) {
    throw new ConflictError(
      'The original webhook context is unavailable.',
      'WEBHOOK_SNAPSHOT_UNAVAILABLE',
    );
  }
  const conn = await getConnection(sctx.env.DB, connectionId);
  if (
    !conn?.enabled ||
    conn.orgId !== row.orgId ||
    conn.generation !== row.generation ||
    conn.mode !== row.connectionMode ||
    !(await isOrgActive(sctx, row.orgId))
  ) {
    throw new ConflictError(
      'The connection changed; this webhook cannot be replayed.',
      'WEBHOOK_STALE_CONTEXT',
    );
  }
  const definition = connectors.get(conn.connectorType);
  if (
    !definition?.verifyWebhook ||
    row.referenceMode === 'unknown' ||
    definition.webhookReferenceMode !== row.referenceMode
  ) {
    throw new ConflictError('The webhook connector changed.', 'WEBHOOK_REFERENCE_MODE_CHANGED');
  }
  const summary = await summarizeItems(sctx.env.DB, row);
  if (!summary)
    throw new UnavailableError('The webhook payload is unavailable.', 'WEBHOOK_PAYLOAD_MISSING');
  if (summary.started)
    throw new ConflictError('A webhook item may still be running.', 'WEBHOOK_EFFECT_UNCERTAIN');
  const previous = JSON.parse(row.releaseSnapshot) as ConnectionReleaseSnapshot;
  const current = await captureConnectionRelease(sctx, conn);
  const changed = !sameRelease(previous, current);
  const rebind = Boolean(summary.blocked) && current?.kind === 'approved';
  // Nothing left to replay is the finding, whatever the release did since receipt.
  if (!rebind && !summary.pending && !summary.failed && row.itemCount > 0) {
    const code = summary.uncertain ? 'WEBHOOK_EFFECT_UNCERTAIN' : 'TEMPLATE_RELEASE_REQUIRED';
    throw new ConflictError('No webhook items can be replayed safely.', code);
  }
  let pinned = previous;
  if (rebind) {
    pinned = current;
  } else if (changed && !(previous?.kind === 'blocked' && summary.pending > 0)) {
    throw new ConflictError('The approved template release changed.', 'TEMPLATE_RELEASE_CONFLICT');
  }
  const payload = await decryptRetainedPayload(sctx, row);
  if ((await requireCredentialRefKeyset(sctx.env.DB, sctx.env)) !== proof) {
    throw new UnavailableError(
      'The webhook credential context is unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  }
  const now = sctx.clock.now();
  const releaseSnapshot = JSON.stringify(pinned);
  const actorType = authority.kind === 'api_key' ? 'api_key' : 'user';
  const actorId = authority.kind === 'api_key' ? authority.keyId : authority.userId;
  if (
    !(await reserveReplay(sctx, row, {
      releaseSnapshot,
      authority,
      now,
      pendingBefore: now - 5 * 60_000,
      replayId: sctx.ids.id(),
      actorType,
      actorId,
      oldRelease: previous?.kind === 'approved' ? previous : null,
      oldBlockCode: previous?.kind === 'blocked' ? previous.code : summary.blockedCode,
      newRelease: pinned?.kind === 'approved' ? pinned : null,
      rebind,
    }))
  ) {
    await assertConnectionAuthority(sctx, authority);
    const code =
      summary.started || summary.uncertain || summary.blocked
        ? 'WEBHOOK_EFFECT_UNCERTAIN'
        : 'WEBHOOK_REPLAY_CONFLICT';
    throw new ConflictError('The webhook changed or cannot be replayed safely.', code);
  }
  try {
    await assertConnectionAuthority(sctx, authority);
    const job: NewConnectionWebhookJob = {
      kind: 'connection.webhook',
      connectionId: row.connectionId,
      orgId: row.orgId,
      generation: row.generation,
      eventId: row.eventId,
      refs: payload.refs,
      ...(payload.chunk ? { chunk: payload.chunk } : {}),
      credentialKeysetCommitment: proof,
    };
    await getDeps().enqueueJob(sctx, job);
  } catch (error) {
    if (await syncKeysetCurrent(sctx, row.credentialKeysetCommitment ?? undefined))
      await restoreFailedReplay(sctx, row, releaseSnapshot, now, authority);
    if (error instanceof ForbiddenError || error instanceof ConflictError) throw error;
    throw new UnavailableError('Could not queue the webhook replay.', 'WEBHOOK_ENQUEUE_FAILED');
  }
}
