import { deleteInBatches } from '../../platform/batched.ts';

export interface Purged {
  feed: number;
  delivered: number;
  attempts: number;
  testAttempts: number;
  secrets: number;
}

/**
 * Daily purge. Feed rows past `feedBefore` go first and take their deliveries and attempts with them
 * (cascade). Then delivered rows, old attempts, test sends and secrets that expired a day ago.
 */
export async function purge(
  db: D1Database,
  cut: {
    feedBefore: number;
    deliveredBefore: number;
    attemptsBefore: number;
    testAttemptsBefore: number;
    secretsBefore: number;
  },
): Promise<Purged> {
  return {
    feed: await deleteInBatches(db, 'event_feed', 'at < ?', [cut.feedBefore]),
    delivered: await deleteInBatches(
      db,
      'webhook_deliveries',
      "state = 'delivered' AND finished_at < ?",
      [cut.deliveredBefore],
    ),
    attempts: await deleteInBatches(db, 'webhook_attempts', 'at < ?', [cut.attemptsBefore]),
    testAttempts: await deleteInBatches(db, 'webhook_attempts', 'event_seq IS NULL AND at < ?', [
      cut.testAttemptsBefore,
    ]),
    secrets: await deleteInBatches(
      db,
      'webhook_endpoint_secrets',
      'expires_at IS NOT NULL AND expires_at < ?',
      [cut.secretsBefore],
    ),
  };
}
