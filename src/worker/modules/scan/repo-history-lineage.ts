import type { Mode } from '../../../shared/contracts/common.ts';
import { RACE_LINEAGE } from './race-tags.ts';
import type { ScanPredicate } from './scan-predicate.ts';

/** The pass state a history read was made under. */
export interface PassLineage {
  orgId: string;
  mode: Mode;
  passId: string;
  credentialGeneration: number;
  lifecycleGeneration: number;
}

/**
 * The pass is still the one its history was read for: not deleted or quarantined, the same
 * lifecycle and credential generation, no credential transfer pending. Every history row of that
 * pass was read in one snapshot, so this one check in the final batch stands for all of them.
 */
export function passLineagePredicate(lineage: PassLineage): ScanPredicate {
  return {
    sql: `EXISTS (${RACE_LINEAGE} SELECT 1 FROM passes lineage
      WHERE lineage.id = ? AND lineage.org_id = ? AND lineage.mode = ?
        AND lineage.deleted_at IS NULL AND lineage.test_data_quarantined = 0
        AND lineage.lifecycle_generation = ? AND lineage.credential_generation = ?
        AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers transfer
          WHERE transfer.pass_id = lineage.id AND transfer.state = 'pending'))`,
    params: [
      lineage.passId,
      lineage.orgId,
      lineage.mode,
      lineage.lifecycleGeneration,
      lineage.credentialGeneration,
    ],
  };
}
