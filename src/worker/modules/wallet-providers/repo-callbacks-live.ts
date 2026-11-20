import { first } from '../../platform/db.ts';

/** The ref still belongs to the pass's current holder and generation. */
export async function samsungRefLive(db: D1Database, referenceId: string): Promise<boolean> {
  return (
    (await first(
      db,
      'SELECT 1 FROM wallet_samsung_fetch_refs WHERE id = ? AND retired_at IS NULL',
      [referenceId],
    )) !== null
  );
}
