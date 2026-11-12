import { first } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { isCredentialKeysetCommitment } from './instance-types.ts';
import { walletRetiredInstanceSettledSql } from './repo-instance-retirement.ts';

/**
 * Purges check every incarnation; transfer completion checks only generations older than the
 * reserved target, since its blocked placeholder has not acquired any provider credential.
 * Both arguments are trusted SQL identifiers; deletion also requires the database trigger.
 */
export function providerRetirementCompleteSql(
  passIdSql: string,
  beforeGenerationSql?: string,
): string {
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;
  if (
    !identifier.test(passIdSql) ||
    (beforeGenerationSql !== undefined && !identifier.test(beforeGenerationSql))
  ) {
    throw new Error('Invalid trusted wallet retirement identifier');
  }
  return `NOT EXISTS (SELECT 1 FROM wallet_provider_instances wallet_retention_instance
    WHERE wallet_retention_instance.pass_id = ${passIdSql}
      ${beforeGenerationSql ? `AND wallet_retention_instance.credential_generation < ${beforeGenerationSql}` : ''}
      AND (NOT EXISTS (SELECT 1 FROM passes wallet_retention_pass
          WHERE wallet_retention_pass.id = wallet_retention_instance.pass_id
            AND wallet_retention_pass.org_id = wallet_retention_instance.org_id
            AND wallet_retention_pass.mode = wallet_retention_instance.mode)
        OR NOT ${walletRetiredInstanceSettledSql('wallet_retention_instance')}))`;
}

/** True until every provider instance is retired and no provider write remains in flight. */
export async function providerRetirementPending(
  db: D1Database,
  passId: string,
  credentialKeysetCommitment: string,
): Promise<boolean> {
  if (!isCredentialKeysetCommitment(credentialKeysetCommitment)) return true;
  const row = await first<{ pending: number }>(
    db,
    `SELECT CASE WHEN ${credentialRefKeysetSql}
      THEN NOT (${providerRetirementCompleteSql('p.id')}) ELSE 1 END AS pending FROM passes p WHERE p.id = ?`,
    [credentialKeysetCommitment, passId],
  );
  return row?.pending !== 0;
}
