import type { z } from 'zod';
import type { ScanLookupResultSchema } from '../../../shared/contracts/scan-session.ts';
import { safeTimestamp } from './card-semantics.ts';
import { cardPrivacy } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import type { PreparedPhotoGrant } from './member-photo.ts';
import type { Candidate } from './repo-lookup.ts';
import { type LookupHistoryProof, lookupHistoryPredicate } from './repo-lookup-history.ts';
import { outputPredicateStmt } from './repo-output-predicates.ts';
import type { SearchRow } from './repo-search.ts';
import type { Found } from './resolve.ts';

export type LookupEntry = {
  item: z.infer<typeof ScanLookupResultSchema>['items'][number];
  found: Found;
  source: Candidate;
  history: LookupHistoryProof | null;
  photoGrant: PreparedPhotoGrant | null;
};

/** Only a last scan whose signed event holds and whose pass was current may contribute a timestamp. */
export function attachLookupHistory(
  actor: ScanActor,
  entries: readonly LookupEntry[],
  rows: readonly SearchRow[],
  proofs: ReadonlyMap<string, LookupHistoryProof>,
): void {
  const byPass = new Map(rows.map((row) => [row.id, row]));
  for (const entry of entries) {
    const row = byPass.get(entry.source.pass.id);
    const proof = row?.last_scan_id ? proofs.get(row.last_scan_id) : undefined;
    if (
      !row ||
      !proof ||
      proof.scan.passId !== entry.source.pass.id ||
      proof.scan.templateId !== entry.source.pass.templateId ||
      proof.scan.at !== row.last_scan_at ||
      !safeTimestamp(cardPrivacy(entry.found, actor), proof.scan.at)
    )
      continue;
    entry.item.lastScanAt = proof.scan.at;
    entry.history = proof;
  }
}

/** Keep the last scan's pass check in the final item-authority transaction. */
export function lookupHistoryStmts(
  db: D1Database,
  history: LookupHistoryProof,
  _now: number,
): D1PreparedStatement[] {
  return [outputPredicateStmt(db, lookupHistoryPredicate(history))];
}
