import { type Check, rowIs } from '../../platform/authority-checks.ts';
import type { Pass } from '../passes/repo-map.ts';
import { noPendingTransferCheck, passTemplateUsableCheck } from './repo-scan-checks.ts';

/** The scanned credential column and the value the preflight matched it by (one, by input kind). */
export type ScanCredentialColumn = 'scan_code' | 'barcode_hash' | 'lookup_hash';

export interface ScanPassFacts {
  pass: Pick<
    Pass,
    | 'status'
    | 'removedAt'
    | 'deletedAt'
    | 'credentialGeneration'
    | 'lifecycleGeneration'
    | 'templateId'
    | 'testDataQuarantined'
  >;
  credential: Partial<Record<ScanCredentialColumn, string>>;
}

/**
 * What a scan commit asks of the pass it resolved (authority-epochs.md F3, F4). All are `lineage`:
 * the pass moved under the request. Content, sync metadata and newer releases are not asked, so a
 * publish, an edit or a sync never refuses a ticket; a void, a removal, a transfer, a quarantine, a
 * template reassignment and a replaced barcode do. The scanned credential is compared directly
 * because a publish can rewrite `barcode_hash` and `lookup_hash` without a generation.
 */
export function scanPassChecks(passId: string, facts: ScanPassFacts): Check[] {
  const { pass, credential } = facts;
  return [
    rowIs(
      'passes',
      passId,
      {
        status: pass.status,
        removed_at: pass.removedAt,
        deleted_at: pass.deletedAt,
        credential_generation: pass.credentialGeneration,
        lifecycle_generation: pass.lifecycleGeneration,
        template_id: pass.templateId,
        test_data_quarantined: pass.testDataQuarantined ? 1 : 0,
        ...credential,
      },
      'lineage',
    ),
    noPendingTransferCheck(passId),
    passTemplateUsableCheck(passId),
  ];
}
