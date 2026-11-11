import type { Envelope } from '../../platform/crypto.ts';
import { batch, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { commitOrNull, connectionGrant, connectionIs, plainWrite } from './repo-grants.ts';
import { eventObserved, inboxMatches } from './repo-legacy-checks.ts';

/** The original record text is retained so sealing does not alter the source. */
export interface LegacyInboxRow {
  ref: string;
  record: string | null;
  deleted: number;
  receivedAt: number;
}

export interface LegacyInboxRead {
  receivedAt: number;
  rows: LegacyInboxRow[];
}

export interface LegacyInboxSource {
  id: string;
  orgId: string;
  envelope: Envelope;
}

interface RawSource {
  id: string;
  org_id: string;
  kek_version: number;
  iv: unknown;
  wrapped_dek: unknown;
  ciphertext: unknown;
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(value as number[]);
}

const EVENT = `SELECT e.received_at AS receivedAt FROM webhook_events e
  JOIN connections c ON c.id = e.connection_id
  WHERE e.connection_id = ? AND e.event_id = ? AND c.org_id = ?`;

/** Read the event and its plaintext rows from one database snapshot. */
export async function readLegacyInbox(
  db: D1Database,
  connectionId: string,
  orgId: string,
  eventId: string,
): Promise<LegacyInboxRead | null> {
  const [event, inbox] = await batch(db, [
    stmt(db, EVENT, [connectionId, eventId, orgId]),
    stmt(
      db,
      `SELECT i.ref, i.record, i.deleted, i.received_at AS receivedAt
      FROM connection_inbox i
      JOIN webhook_events e ON e.connection_id = i.connection_id AND e.event_id = i.event_id
      JOIN connections c ON c.id = e.connection_id
      WHERE i.connection_id = ? AND i.event_id = ? AND c.org_id = ? ORDER BY i.ref`,
      [connectionId, eventId, orgId],
    ),
  ]);
  const current = event?.results[0] as { receivedAt: number } | undefined;
  if (!current || !inbox) return null;
  return { receivedAt: current.receivedAt, rows: inbox.results as LegacyInboxRow[] };
}

export type LegacyInboxCommit =
  | { status: 'missing' }
  | { status: 'changed' }
  | { status: 'sealed'; sources: LegacyInboxSource[] };

/**
 * Compare every raw row and the event identity before inserting the envelope. Normal
 * sealing deletes plaintext in the same batch; cleanup can retain it until its marker
 * and item provenance commit. A failed comparison never deletes plaintext.
 */
export async function commitLegacyInbox(
  ctx: ServiceContext,
  connectionId: string,
  orgId: string,
  eventId: string,
  observed: LegacyInboxRead,
  source: { id: string; envelope: Envelope; receivedAt: number } | null,
  retainPlaintext: boolean,
): Promise<LegacyInboxCommit> {
  const db = ctx.env.DB;
  const sources = stmt(
    db,
    `SELECT id, org_id, kek_version, iv, wrapped_dek, ciphertext
    FROM connection_webhook_legacy_sources WHERE connection_id = ? AND event_id = ?
    ORDER BY received_at, id`,
    [connectionId, eventId],
  );
  const event = stmt(db, EVENT, [connectionId, eventId, orgId]);

  let results: D1Result[];
  let sourcesIndex: number;
  let matched: boolean;
  if (source) {
    const { envelope } = source;
    const actor = { orgId };
    const g = connectionGrant(
      ctx,
      actor,
      'webhook.legacy_seal',
      [
        connectionIs({ id: connectionId }),
        eventObserved(connectionId, eventId, Number.MAX_SAFE_INTEGER, observed.receivedAt),
        inboxMatches(connectionId, eventId, observed),
      ],
      eventId,
    );
    plainWrite(
      g,
      `INSERT INTO connection_webhook_legacy_sources
        (id, connection_id, org_id, event_id, kek_version, iv, wrapped_dek, ciphertext, received_at)
       SELECT ?, ?, {org}, ?, ?, ?, ?, ?, ? WHERE {grant}`,
      [
        source.id,
        connectionId,
        eventId,
        envelope.kekVersion,
        envelope.iv,
        envelope.wrappedDek,
        envelope.ciphertext,
        source.receivedAt,
      ],
    );
    if (!retainPlaintext)
      plainWrite(
        g,
        'DELETE FROM connection_inbox WHERE connection_id = ? AND event_id = ? AND {grant}',
        [connectionId, eventId],
      );
    matched = (await commitOrNull(g, actor)) !== null;
    results = await batch(db, [sources, event]);
    sourcesIndex = 0;
  } else {
    // Avoid accumulating empty envelopes, but still compare the empty observation with the source read
    // so a late inbox write is not silently missed. The keyset is pinned by the caller.
    results = await batch(db, [
      stmt(
        db,
        `SELECT 1 AS matched WHERE EXISTS (SELECT 1 FROM webhook_events e JOIN connections c ON c.id = e.connection_id
          WHERE e.connection_id = ? AND e.event_id = ? AND c.org_id = ? AND e.received_at = ?)
        AND NOT EXISTS (SELECT 1 FROM connection_inbox WHERE connection_id = ? AND event_id = ?)`,
        [connectionId, eventId, orgId, observed.receivedAt, connectionId, eventId],
      ),
      sources,
      event,
    ]);
    sourcesIndex = 1;
    matched = results[0]?.results.length === 1;
  }

  if (!results[sourcesIndex + 1]?.results.length) return { status: 'missing' };
  if (!matched) return { status: 'changed' };
  const sourceResult = results[sourcesIndex];
  if (!sourceResult) return { status: 'changed' };
  return {
    status: 'sealed',
    sources: (sourceResult.results as RawSource[]).map((row) => ({
      id: row.id,
      orgId: row.org_id,
      envelope: {
        kekVersion: row.kek_version,
        iv: bytes(row.iv),
        wrappedDek: bytes(row.wrapped_dek),
        ciphertext: bytes(row.ciphertext),
      },
    })),
  };
}
