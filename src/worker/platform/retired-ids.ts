import { deleteInBatches } from './batched.ts';
import type { ServiceContext } from './service-context.ts';

const DAY = 86_400_000;
/** Longer than any session, scanner or API key could still present a retired id. Mirrored in migration 0086. */
export const RETIRED_ID_RETENTION_MS = 400 * DAY;

/** Deletes retired ids older than the retention window; the delete triggers refuse younger rows. */
export async function purgeRetiredIds(ctx: ServiceContext): Promise<Record<string, number>> {
  const cutoff = ctx.clock.now() - RETIRED_ID_RETENTION_MS;
  const del = (table: string) => deleteInBatches(ctx.env.DB, table, 'retired_at < ?', [cutoff]);
  const removed = {
    sessions: await del('retired_session_ids'),
    scanners: await del('retired_scanner_ids'),
    apiKeys: await del('retired_api_key_ids'),
  };
  ctx.log.info('authority.retired_ids_purged', removed);
  return removed;
}
