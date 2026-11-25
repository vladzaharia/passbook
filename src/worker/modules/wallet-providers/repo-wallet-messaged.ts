import { batch } from '../../platform/db.ts';
import { type EventRow, insertEventStmt } from '../events/repo.ts';

/** One `wallet.messaged` event, written once: a row with this id is never added twice. */
export async function insertWalletMessagedEvent(db: D1Database, row: EventRow): Promise<void> {
  await batch(db, [
    insertEventStmt(db, row, {
      sql: 'NOT EXISTS (SELECT 1 FROM pass_events e WHERE e.id = ?)',
      params: [row.id],
    }),
  ]);
}
