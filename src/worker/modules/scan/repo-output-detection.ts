import type { Pass } from '../passes/repo-map.ts';
import { noCredentialTombstonesSql } from './repo-credential-tombstones.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

/**
 * Proof for a bare cross-mode detection (`test_pass` / `live_pass`): the output names no pass, so
 * only the credential's identity and standing are authority. Personalization, Wallet content and
 * releases are content and may move after projection.
 */
export function detectionOutputPredicate(input: {
  pass: Pass;
  credentialTombstoneRefs: readonly string[];
  credentialKeysetCommitment: string;
}): OutputPredicate {
  const { pass } = input;
  if (
    !Number.isSafeInteger(pass.credentialGeneration) ||
    !Number.isSafeInteger(pass.lifecycleGeneration)
  )
    return { sql: '0', params: [] };
  const tombstones = noCredentialTombstonesSql(
    input.credentialTombstoneRefs,
    { orgIdSql: 'p.org_id', modeSql: 'p.mode' },
    input.credentialKeysetCommitment,
  );
  return {
    sql: `EXISTS (SELECT 1 FROM passes p WHERE p.id=? AND p.org_id=? AND p.mode=?
      AND p.credential_generation=? AND p.lifecycle_generation=?
      AND p.deleted_at IS NULL AND p.test_data_quarantined=0
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.pass_id=p.id AND t.state='pending')
      AND (${tombstones.sql}))`,
    params: [
      pass.id,
      pass.orgId,
      pass.mode,
      pass.credentialGeneration,
      pass.lifecycleGeneration,
      ...tombstones.params,
    ],
  };
}
