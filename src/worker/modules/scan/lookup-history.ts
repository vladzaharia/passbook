import type { z } from 'zod';
import type { ScanLookupResultSchema } from '../../../shared/contracts/scan-session.ts';
import { safeTimestamp } from './card-semantics.ts';
import { cardPrivacy } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import { historyProofPolicySources, type VerifiedHistoryProof } from './history-proof.ts';
import type { PreparedPhotoGrant } from './member-photo.ts';
import type { HistoryProofFence } from './repo-history-proof-cas.ts';
import type { Candidate } from './repo-lookup.ts';
import { lookupHistoryEventPredicate, lookupHistorySnapshots } from './repo-lookup-history.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';
import type { SearchRow } from './repo-search.ts';
import type { Found } from './resolve.ts';

export type LookupEntry = {
  item: z.infer<typeof ScanLookupResultSchema>['items'][number];
  found: Found;
  source: Candidate;
  history: HistoryProofFence | null;
  photoGrant: PreparedPhotoGrant | null;
};

/** Only verified, current immutable events may contribute a last-scan timestamp. */
export function attachLookupHistory(
  actor: ScanActor,
  entries: readonly LookupEntry[],
  rows: readonly SearchRow[],
  proofs: ReadonlyMap<string, VerifiedHistoryProof>,
): void {
  const byPass = new Map(rows.map((row) => [row.id, row]));
  for (const entry of entries) {
    const row = byPass.get(entry.source.pass.id);
    const proof = row?.last_scan_id ? proofs.get(row.last_scan_id) : undefined;
    const source = proof ? historyProofPolicySources(proof) : null;
    if (
      !row ||
      !proof ||
      !source ||
      !proof.projectionCurrent ||
      source.scan.passId !== entry.source.pass.id ||
      source.scan.templateId !== entry.source.pass.templateId ||
      source.scan.at !== row.last_scan_at ||
      !safeTimestamp(entry.found, actor, cardPrivacy(entry.found, actor), source.scan.at)
    )
      continue;
    entry.item.lastScanAt = source.scan.at;
    entry.history = proof;
  }
}

/** Keep every verified event fragment in the final item-authority transaction. */
export function lookupHistoryStmts(
  db: D1Database,
  history: HistoryProofFence,
  now: number,
): D1PreparedStatement[] {
  return lookupHistorySnapshots(history, now).map((proof) =>
    outputPredicateStmt(db, lookupHistoryEventPredicate(history, proof)),
  );
}
