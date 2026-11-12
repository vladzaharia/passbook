import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { AppError, UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  captureCredentialKeyEnv,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { legacyCleanupHash } from './legacy-duplicate-key.ts';
import { type LegacyKeySnapshot, parseRecord, sealLegacyInboxForCleanup } from './legacy-inbox.ts';
import { readLegacyInbox } from './repo-legacy-inbox.ts';
import {
  appendCleanupSource,
  insertCleanupRetention,
  type LegacyEventCandidate,
  legacyEventsBefore,
} from './repo-legacy-quarantine.ts';
import type { InboxItem } from './repo-pass-inbox.ts';
import { type RetainedRow, retainedByChunk } from './repo-webhook-retention.ts';

const BATCH_SIZE = 20;

/** Preserve old events without treating a cleanup observation as execution authority. */
export async function quarantineLegacyWebhookEvents(
  ctx: ServiceContext,
  before: number,
  limit = BATCH_SIZE,
): Promise<number> {
  try {
    const env = captureCredentialKeyEnv(ctx.env);
    const keys = { env, commitment: await requireCredentialRefKeyset(ctx.env.DB, env) };
    return await quarantine(ctx, before, limit, keys);
  } catch {
    // Database and crypto errors can contain upstream-controlled values.
    throw new UnavailableError('Could not retain the webhook.', 'WEBHOOK_RETENTION_FAILED');
  }
}

/** A page that still has failures is followed by the next, so a few bad events cannot starve the rest. */
const MAX_PAGES = 5;

async function quarantine(
  ctx: ServiceContext,
  before: number,
  limit: number,
  keys: LegacyKeySnapshot,
): Promise<number> {
  const bounded = Number.isFinite(limit)
    ? Math.max(0, Math.min(BATCH_SIZE, Math.floor(limit)))
    : BATCH_SIZE;
  if (!bounded) return 0;
  let staged = 0;
  let after: Parameters<typeof legacyEventsBefore>[3];
  for (let page = 0; page < MAX_PAGES; page++) {
    const candidates = await legacyEventsBefore(ctx.env.DB, before, bounded, after);
    let failed = 0;
    for (const event of candidates) {
      // One bad event is logged and skipped; it must not stop the others or the rest of retention.
      try {
        if (await quarantineEvent(ctx, event, before, keys)) staged++;
      } catch (error) {
        failed++;
        ctx.log.error('connection.legacy_event_quarantine_failed', {
          connectionId: event.connectionId,
          code: error instanceof AppError ? error.code : 'LEGACY_QUARANTINE_FAILED',
        });
      }
    }
    const last = candidates.at(-1);
    if (!last || !failed || candidates.length < bounded) break;
    after = { receivedAt: last.receivedAt, connectionId: last.connectionId, eventId: last.eventId };
  }
  return staged;
}

async function quarantineEvent(
  ctx: ServiceContext,
  event: LegacyEventCandidate,
  before: number,
  keys: LegacyKeySnapshot,
): Promise<boolean> {
  // Legacy inbox rows have no tenant column; existing foreign evidence makes ownership ambiguous.
  if (event.foreignEvidence) {
    throw new UnavailableError('Could not retain the webhook.', 'WEBHOOK_RETENTION_FAILED');
  }
  const refHash = await legacyCleanupHash(
    ctx,
    event.connectionId,
    event.eventId,
    undefined,
    keys.env,
  );
  const existing = await retainedByChunk(ctx.env.DB, event.connectionId, event.eventId, refHash);
  if (existing) return appendExistingInbox(ctx, event, before, existing, keys);
  // Keep plaintext until the marker and its item provenance commit atomically.
  const { items, observed } = await sealLegacyInboxForCleanup(
    ctx,
    event.connectionId,
    event.orgId,
    event.eventId,
    keys,
  );
  const row = await cleanupRow(ctx, event, items, refHash, keys);
  if (await insertCleanupRetention(ctx, row, event.mode, before, observed, keys.commitment)) {
    return true;
  }
  if ((await requireCredentialRefKeyset(ctx.env.DB, keys.env)) !== keys.commitment) {
    throw new UnavailableError('Could not retain the webhook.', 'WEBHOOK_RETENTION_FAILED');
  }
  // A competing cleanup may have created the marker after the candidate query.
  // Preserve any remaining rows as a new source rather than replacing its envelope.
  const winner = await retainedByChunk(ctx.env.DB, event.connectionId, event.eventId, refHash);
  if (!winner)
    throw new UnavailableError('Could not retain the webhook.', 'WEBHOOK_RETENTION_FAILED');
  return appendExistingInbox(ctx, event, before, winner, keys);
}

async function appendExistingInbox(
  ctx: ServiceContext,
  event: LegacyEventCandidate,
  before: number,
  marker: RetainedRow,
  keys: LegacyKeySnapshot,
): Promise<boolean> {
  if (marker.source !== 'legacy_cleanup_unproven' || marker.orgId !== event.orgId) {
    throw new UnavailableError('Could not retain the webhook.', 'WEBHOOK_RETENTION_FAILED');
  }
  const observed = await readLegacyInbox(
    ctx.env.DB,
    event.connectionId,
    event.orgId,
    event.eventId,
  );
  if (!observed)
    throw new UnavailableError('Could not retain the webhook.', 'WEBHOOK_RETENTION_FAILED');
  if (!observed.rows.length) return false;

  const items: InboxItem[] = observed.rows.map((item) => ({
    ref: item.ref,
    record: parseRecord(item.record),
    deleted: item.deleted === 1,
  }));
  const sourceId = ctx.ids.id();
  const now = ctx.clock.now();
  const envelope = await encryptSecret(
    await loadKekRing(keys.env),
    JSON.stringify({
      version: 1,
      connectionId: event.connectionId,
      eventId: event.eventId,
      eventReceivedAt: observed.receivedAt,
      rows: observed.rows,
    }),
    credentialAad(sourceId, event.orgId, 'connection.webhook.legacy-inbox'),
  );
  const refHash = await legacyCleanupHash(
    ctx,
    event.connectionId,
    event.eventId,
    sourceId,
    keys.env,
  );
  const row = await cleanupRow(ctx, event, items, refHash, keys, sourceId);
  if (
    !(await appendCleanupSource(
      ctx,
      marker.id,
      row,
      event,
      before,
      observed,
      {
        id: sourceId,
        envelope,
        receivedAt: now,
      },
      keys.commitment,
    ))
  ) {
    throw new UnavailableError('Could not retain the webhook.', 'WEBHOOK_RETENTION_FAILED');
  }
  return true;
}

async function cleanupRow(
  ctx: ServiceContext,
  event: LegacyEventCandidate,
  items: InboxItem[],
  refHash: string,
  keys: LegacyKeySnapshot,
  legacySourceId?: string,
): Promise<RetainedRow> {
  const id = ctx.ids.id();
  const now = ctx.clock.now();
  const payload = {
    refs: items.map((item) => item.ref),
    items,
    rawBody: null,
    credentialKeysetCommitment: null,
    ...(legacySourceId === undefined ? {} : { legacySourceId }),
  };
  return {
    id,
    connectionId: event.connectionId,
    orgId: event.orgId,
    eventId: event.eventId,
    generation: event.generation,
    source: 'legacy_cleanup_unproven',
    connectionMode: event.mode === 'webhook' || event.mode === 'hybrid' ? event.mode : 'unknown',
    referenceMode: 'unknown',
    refHash,
    state: 'failed',
    errorCode: 'WEBHOOK_LEGACY_UNCERTAIN',
    releaseSnapshot: 'null',
    snapshotKnown: false,
    revision: 0,
    itemCount: items.length,
    chunkCount: 1,
    replayGeneration: 0,
    credentialKeysetCommitment: null,
    envelope: await encryptSecret(
      await loadKekRing(keys.env),
      JSON.stringify(payload),
      credentialAad(id, event.orgId, 'connection.webhook'),
    ),
    receivedAt: now,
    updatedAt: now,
  };
}
