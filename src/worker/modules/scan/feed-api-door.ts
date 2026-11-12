import type { ServiceContext } from '../../platform/service-context.ts';
import { historyOf } from './feed-projection-history.ts';
import type { HistoryPolicy } from './history-policy.ts';
import { historyProofSnapshotsForScopes } from './history-proof.ts';
import type { ScanLogRow } from './repo-feed.ts';
import type { ScanEventProofCache } from './scan-event-proof.ts';

const BATCH = 32;

/**
 * The door's event-time history policy for each verified row with an effect value. An API key has
 * no scan role, so its feed shows only the values the door could see; rows without one show none.
 */
export async function doorHistories(
  ctx: ServiceContext,
  rows: readonly ScanLogRow[],
  credentialKeysetCommitment: string,
  proofCache: ScanEventProofCache,
): Promise<Map<string, HistoryPolicy>> {
  const valued = rows.filter(
    (row) =>
      row.policyAvailable &&
      row.passId !== null &&
      row.eventProof &&
      (row.before !== null || row.after !== null),
  );
  const result = new Map<string, HistoryPolicy>();
  if (!valued.length) return result;
  const proofs = await historyProofSnapshotsForScopes(
    ctx,
    valued.map((row) => ({ orgId: row.orgId, mode: row.mode, scanId: row.id })),
    new Map(),
    credentialKeysetCommitment,
    proofCache,
  );
  for (let start = 0; start < valued.length; start += BATCH) {
    await Promise.all(
      valued.slice(start, start + BATCH).map(async (row) => {
        const proof = proofs.get(row.id);
        const history = proof ? await historyOf(ctx, row, proof, 'door', proofCache) : null;
        if (history) result.set(row.id, history);
      }),
    );
  }
  return result;
}
