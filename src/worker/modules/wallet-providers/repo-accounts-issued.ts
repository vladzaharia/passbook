import type { WalletProviderScope } from '../../../shared/contracts/wallet-providers.ts';
import { first } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type { AccountRow } from './repo-accounts.ts';

/**
 * Verification material for a callback on an issued ref whose operation no longer fits the live
 * fences: the credential configured at a revision this instance has operated under. It never
 * signs or reads card data.
 */
export function findSamsungIssuedRefCredential(
  db: D1Database,
  input: {
    orgId: string;
    mode: WalletProviderScope['mode'];
    accountId: string;
    accountRevision: number;
    refHash: string;
    credentialKeysetCommitment: string;
  },
): Promise<AccountRow | null> {
  return first(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider, e.revision, e.credential_id,
      NULL AS revoked_at, e.created_at AS updated_at, c.kek_version, c.iv, c.wrapped_dek, c.ciphertext
    FROM wallet_samsung_fetch_refs r
    JOIN wallet_provider_instances i ON i.id = r.instance_id
    JOIN wallet_provider_accounts a ON a.id = i.account_id AND a.org_id = i.org_id
      AND a.mode = i.mode AND a.provider = 'samsung'
    JOIN wallet_provider_account_events e ON e.account_id = a.id AND e.org_id = a.org_id
      AND e.mode = a.mode AND e.provider = a.provider AND e.revision = ? AND e.kind = 'configure'
    JOIN wallet_provider_credentials c ON c.id = e.credential_id AND c.account_id = a.id
      AND c.org_id = a.org_id AND c.mode = a.mode AND c.provider = a.provider
    WHERE r.ref_hash = ? AND i.org_id = ? AND i.mode = ? AND i.account_id = ?
      AND r.credential_keyset_commitment = ? AND ${credentialRefKeysetSql}
      AND EXISTS (SELECT 1 FROM wallet_provider_instance_operations o
        WHERE o.instance_id = i.id AND o.account_revision = e.revision)`,
    [
      input.accountRevision,
      input.refHash,
      input.orgId,
      input.mode,
      input.accountId,
      input.credentialKeysetCommitment,
      input.credentialKeysetCommitment,
    ],
  );
}
