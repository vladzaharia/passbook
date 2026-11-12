import type { Grant } from '../../platform/authority.ts';
import { rawCheck } from '../../platform/authority-checks.ts';
import type { Envelope } from '../../platform/crypto.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  commitOrNull,
  connectionGrant,
  connectionIs,
  plainWrite,
  retentionIs,
} from './repo-grants.ts';
import { eventObserved, inboxMatches } from './repo-legacy-checks.ts';
import type { LegacyInboxRead } from './repo-legacy-inbox.ts';
import {
  RETENTION_INSERT_COLUMNS,
  type RetainedRow,
  retentionInsertValues,
} from './repo-webhook-retention.ts';

export interface LegacyEventCandidate {
  connectionId: string;
  orgId: string;
  eventId: string;
  generation: number;
  mode: 'poll' | 'webhook' | 'hybrid' | 'manual' | 'snapshot';
  foreignEvidence: number;
  receivedAt: number;
}

/** Old schema had no per-item completion evidence, so never presume these events resolved. */
export async function legacyEventsBefore(
  db: D1Database,
  before: number,
  limit: number,
  after?: { receivedAt: number; connectionId: string; eventId: string },
): Promise<LegacyEventCandidate[]> {
  return all<LegacyEventCandidate>(
    db,
    `SELECT e.connection_id AS connectionId, c.org_id AS orgId,
      e.event_id AS eventId, c.generation, c.mode, e.received_at AS receivedAt,
      (EXISTS (SELECT 1 FROM connection_webhook_retention r
        WHERE r.connection_id = e.connection_id AND r.event_id = e.event_id AND r.org_id <> c.org_id)
       OR EXISTS (SELECT 1 FROM connection_webhook_legacy_sources s
        WHERE s.connection_id = e.connection_id AND s.event_id = e.event_id AND s.org_id <> c.org_id)
      ) AS foreignEvidence FROM webhook_events e
    JOIN connections c ON c.id = e.connection_id
    WHERE e.received_at < ?${
      after ? ' AND (e.received_at, e.connection_id, e.event_id) > (?, ?, ?)' : ''
    } AND (
      EXISTS (SELECT 1 FROM connection_inbox i
        WHERE i.connection_id = e.connection_id AND i.event_id = e.event_id)
      OR NOT EXISTS (SELECT 1 FROM connection_webhook_retention r
        WHERE r.connection_id = e.connection_id AND r.event_id = e.event_id)
    )
    ORDER BY e.received_at, e.connection_id, e.event_id LIMIT ?`,
    [before, ...(after ? [after.receivedAt, after.connectionId, after.eventId] : []), limit],
  );
}

/** Anything another org already holds for this event keeps it out of quarantine (read just before the grant). */
async function foreignEvidence(
  db: D1Database,
  connectionId: string,
  eventId: string,
  orgId: string,
) {
  return (
    (await first(
      db,
      `SELECT 1 FROM connection_webhook_retention r
        WHERE r.connection_id = ? AND r.event_id = ? AND r.org_id <> ?
       UNION ALL SELECT 1 FROM connection_webhook_legacy_sources s
        WHERE s.connection_id = ? AND s.event_id = ? AND s.org_id <> ? LIMIT 1`,
      [connectionId, eventId, orgId, connectionId, eventId, orgId],
    )) !== null
  );
}

function sealItems(g: Grant, row: RetainedRow): void {
  for (let ordinal = 0; ordinal < row.itemCount; ordinal++)
    g.insertJoined('connection_webhook_items', {
      parents: { retention_id: row.id },
      columns: ['ordinal', 'state', 'error_code', 'prior_unknown', 'release_snapshot'],
      values: [ordinal, 'failed', 'WEBHOOK_LEGACY_UNCERTAIN', 1, row.releaseSnapshot],
    });
}

const deleteInbox = (g: Grant, connectionId: string, eventId: string) =>
  plainWrite(
    g,
    'DELETE FROM connection_inbox WHERE connection_id = ? AND event_id = ? AND {grant}',
    [connectionId, eventId],
  );

/** Quarantine must also preserve disabled and non-webhook connections without authorizing work. */
export async function insertCleanupRetention(
  ctx: ServiceContext,
  row: RetainedRow,
  mode: string,
  before: number,
  observed: LegacyInboxRead,
  credentialKeysetCommitment: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(credentialKeysetCommitment)) return false;
  if (await foreignEvidence(ctx.env.DB, row.connectionId, row.eventId, row.orgId)) return false;
  const actor = { orgId: row.orgId };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.quarantine',
    [
      rawCheck(
        'retention',
        'NOT EXISTS (SELECT 1 FROM connection_webhook_retention WHERE id = ? OR (connection_id = ? AND event_id = ? AND ref_hash = ?))',
        [row.id, row.connectionId, row.eventId, row.refHash],
      ),
      connectionIs({ id: row.connectionId, generation: row.generation, syncMode: mode }),
      eventObserved(row.connectionId, row.eventId, before, observed.receivedAt),
      inboxMatches(row.connectionId, row.eventId, observed),
    ],
    row.id,
  );
  g.insertSelect(
    'connection_webhook_retention',
    RETENTION_INSERT_COLUMNS,
    retentionInsertValues(row),
  );
  sealItems(g, row);
  deleteInbox(g, row.connectionId, row.eventId);
  return (await commitOrNull(g, actor)) !== null;
}

/** Commit a new review marker and encrypted late source before deleting its plaintext. */
export async function appendCleanupSource(
  ctx: ServiceContext,
  priorMarkerId: string,
  row: RetainedRow,
  event: LegacyEventCandidate,
  before: number,
  observed: LegacyInboxRead,
  source: { id: string; envelope: Envelope; receivedAt: number },
  credentialKeysetCommitment: string,
): Promise<boolean> {
  if (
    !/^[0-9a-f]{64}$/.test(credentialKeysetCommitment) ||
    !observed.rows.length ||
    row.itemCount !== observed.rows.length
  )
    return false;
  if (await foreignEvidence(ctx.env.DB, event.connectionId, event.eventId, event.orgId))
    return false;
  const { envelope } = source;
  const actor = { orgId: event.orgId };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.quarantine_append',
    [
      connectionIs({ id: event.connectionId, generation: event.generation, syncMode: event.mode }),
      eventObserved(event.connectionId, event.eventId, before, observed.receivedAt),
      retentionIs(priorMarkerId, {
        connection_id: event.connectionId,
        event_id: event.eventId,
        source: 'legacy_cleanup_unproven',
      }),
      inboxMatches(event.connectionId, event.eventId, observed),
    ],
    row.id,
  );
  plainWrite(
    g,
    `INSERT INTO connection_webhook_legacy_sources
      (id, connection_id, org_id, event_id, kek_version, iv, wrapped_dek, ciphertext, received_at)
     SELECT ?, ?, {org}, ?, ?, ?, ?, ?, ? WHERE {grant}`,
    [
      source.id,
      event.connectionId,
      event.eventId,
      envelope.kekVersion,
      envelope.iv,
      envelope.wrappedDek,
      envelope.ciphertext,
      source.receivedAt,
    ],
  );
  g.insertSelect(
    'connection_webhook_retention',
    RETENTION_INSERT_COLUMNS,
    retentionInsertValues(row),
  );
  sealItems(g, row);
  deleteInbox(g, event.connectionId, event.eventId);
  return (await commitOrNull(g, actor)) !== null;
}
