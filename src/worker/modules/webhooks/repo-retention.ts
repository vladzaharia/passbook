import { deleteInBatches } from '../../platform/batched.ts';
import type { Scope } from '../retention/repo-sweep.ts';

export interface Purged {
  feed: number;
  delivered: number;
  attempts: number;
  testAttempts: number;
}

/** A hold on the org or on the event's pass keeps the event's rows. */
const heldEvent = (seqColumn: string) =>
  `EXISTS (SELECT 1 FROM event_feed f JOIN retention_holds h ON h.released_at IS NULL AND h.org_id = f.org_id
     AND (h.pass_id IS NULL OR h.pass_id = f.pass_id) WHERE f.seq = ${seqColumn})`;

/** The platform pass skips the listed orgs; an org pass takes one. */
const inScope = (table: string, scope: Scope): { sql: string; params: string[] } =>
  scope.kind === 'org'
    ? { sql: `${table}.org_id = ?`, params: [scope.orgId] }
    : {
        sql: `${table}.org_id NOT IN (SELECT value FROM json_each(?))`,
        params: [JSON.stringify(scope.exclude)],
      };

/**
 * Purge of one scope. Feed rows past `feedBefore` go first and take their deliveries and attempts with them
 * (cascade). Then delivered rows, old attempts and test sends. Held events keep all of theirs.
 */
export async function purge(
  db: D1Database,
  cut: {
    feedBefore: number;
    deliveredBefore: number;
    attemptsBefore: number;
    testAttemptsBefore: number;
  },
  scope: Scope,
): Promise<Purged> {
  const feed = inScope('event_feed', scope);
  const deliveries = inScope('webhook_deliveries', scope);
  const attempts = inScope('webhook_attempts', scope);
  return {
    feed: await deleteInBatches(
      db,
      'event_feed',
      `at < ? AND ${feed.sql} AND NOT ${heldEvent('event_feed.seq')}`,
      [cut.feedBefore, ...feed.params],
    ),
    delivered: await deleteInBatches(
      db,
      'webhook_deliveries',
      `state = 'delivered' AND finished_at < ? AND ${deliveries.sql} AND NOT ${heldEvent('webhook_deliveries.event_seq')}`,
      [cut.deliveredBefore, ...deliveries.params],
    ),
    attempts: await deleteInBatches(
      db,
      'webhook_attempts',
      `at < ? AND ${attempts.sql} AND (event_seq IS NULL OR NOT ${heldEvent('webhook_attempts.event_seq')})`,
      [cut.attemptsBefore, ...attempts.params],
    ),
    testAttempts: await deleteInBatches(
      db,
      'webhook_attempts',
      `event_seq IS NULL AND at < ? AND ${attempts.sql}`,
      [cut.testAttemptsBefore, ...attempts.params],
    ),
  };
}

/** Secrets of a rotated key are gone a day after they expire; not history, so no class or hold. */
export const purgeSecrets = (db: D1Database, before: number): Promise<number> =>
  deleteInBatches(db, 'webhook_endpoint_secrets', 'expires_at IS NOT NULL AND expires_at < ?', [
    before,
  ]);
