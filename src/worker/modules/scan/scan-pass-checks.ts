import { type Check, rawCheck, rowIs } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import type { Pass } from '../passes/repo-map.ts';

/** The scanned credential column and the value the preflight matched it by (one, by input kind). */
export type ScanCredentialColumn = 'scan_code' | 'barcode_hash' | 'lookup_hash';

export interface ScanPassFacts {
  pass: Pick<
    Pass,
    | 'status'
    | 'removedAt'
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
        credential_generation: pass.credentialGeneration,
        lifecycle_generation: pass.lifecycleGeneration,
        template_id: pass.templateId,
        test_data_quarantined: pass.testDataQuarantined ? 1 : 0,
        ...credential,
      },
      'lineage',
    ),
    rawCheck(
      'lineage',
      `NOT EXISTS (SELECT 1 FROM pass_credential_transfers x WHERE x.pass_id = ? AND x.state = 'pending')`,
      [passId],
    ),
    // The template must exist for the actor's org (archived is fine, use does not need the head); a reassignment is caught here.
    tenantCheck(
      'lineage',
      `EXISTS (SELECT 1 FROM passes p JOIN templates t ON t.id = p.template_id
        WHERE p.id = ? AND t.status != 'deleted' AND (t.org_id IS NULL OR t.org_id = {org}))`,
      [passId],
    ),
  ];
}
