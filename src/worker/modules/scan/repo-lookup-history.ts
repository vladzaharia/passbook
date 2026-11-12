import {
  type HistoryProofFence,
  historyProofSnapshotPredicates,
} from './repo-history-proof-cas.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

export function lookupHistorySnapshots(history: HistoryProofFence, now: number) {
  return historyProofSnapshotPredicates(history, 's', now);
}

export function lookupHistoryEventPredicate(
  history: HistoryProofFence,
  proof: OutputPredicate,
): OutputPredicate {
  return {
    sql: `EXISTS (SELECT 1 FROM scans s WHERE s.id=?/* scan-ephemeral-scan-id */ AND (${proof.sql}))`,
    params: [history.scan.id, ...proof.params],
  };
}
