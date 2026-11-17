import type { ServiceContext } from '../../platform/service-context.ts';
import type { HistoryPolicy } from './history-policy.ts';
import type { HistoryRow } from './history-row.ts';
import { type HistoryEvidenceCache, historyEvidenceOf } from './history-row-evidence.ts';

/**
 * The door's event-time history policy for each verified row with an effect value. An API key has
 * no scan role, so its feed shows only the values the door could see; rows without one show none.
 */
export async function doorHistories(
  ctx: ServiceContext,
  rows: readonly HistoryRow[],
  cache: HistoryEvidenceCache,
): Promise<Map<string, HistoryPolicy>> {
  const evidence = await historyEvidenceOf(ctx, rows, {
    role: 'door',
    cache,
    requireAvailable: true,
    wanted: (row) => row.passId !== null && (row.before !== null || row.after !== null),
  });
  const result = new Map<string, HistoryPolicy>();
  for (const [id, found] of evidence) if (found.policy) result.set(id, found.policy);
  return result;
}
