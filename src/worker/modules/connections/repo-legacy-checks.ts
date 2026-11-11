import { type Check, rawCheck } from '../../platform/authority-checks.ts';

/** The inbox still holds exactly the rows that were sealed into the retained envelope. */
export const inboxMatches = (
  connectionId: string,
  eventId: string,
  observed: { receivedAt: number; rows: unknown[] },
): Check =>
  rawCheck(
    'retention',
    `(SELECT COUNT(*) FROM connection_inbox WHERE connection_id = ? AND event_id = ?) = ?
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) expected LEFT JOIN connection_inbox actual
          ON actual.connection_id = ? AND actual.event_id = ?
          AND actual.ref = json_extract(expected.value, '$.ref')
        WHERE actual.connection_id IS NULL
          OR actual.record IS NOT json_extract(expected.value, '$.record')
          OR actual.deleted IS NOT json_extract(expected.value, '$.deleted')
          OR actual.received_at IS NOT json_extract(expected.value, '$.receivedAt'))`,
    [
      connectionId,
      eventId,
      observed.rows.length,
      JSON.stringify(observed.rows),
      connectionId,
      eventId,
    ],
  );

export const eventObserved = (
  connectionId: string,
  eventId: string,
  before: number,
  receivedAt: number,
): Check =>
  rawCheck(
    'retention',
    'EXISTS (SELECT 1 FROM webhook_events e WHERE e.connection_id = ? AND e.event_id = ? AND e.received_at < ? AND e.received_at = ?)',
    [connectionId, eventId, before, receivedAt],
  );
