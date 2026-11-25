import type { WalletProviderScope } from '../../../shared/contracts/wallet-providers.ts';
import { first } from '../../platform/db.ts';
import type { AccountRow } from './repo-accounts.ts';
import { pinnedKeysetSql } from './repo-keyset-pin.ts';

export type IssuedCredentialRow = AccountRow & {
  /** The account's current revision and whether the account is revoked, beside the row's own revision. */
  current_revision: number;
  account_revoked_at: number | null;
  pin_version_id: string | null;
  card_type: string | null;
};

/**
 * Verification material for a callback on an issued ref whose operation no longer fits the live
 * fences: the credential configured at a revision this instance has operated under (or, with
 * `operated: false`, the account's current one, to compare against). It never signs or reads card
 * data, and says whether it is current so a caller can refuse to let an old credential write.
 */
export function findSamsungIssuedRefCredential(
  db: D1Database,
  input: {
    orgId: string;
    mode: WalletProviderScope['mode'];
    accountId: string;
    accountRevision: number;
    refHash: string;
    operated: boolean;
  },
): Promise<IssuedCredentialRow | null> {
  return first(
    db,
    `SELECT a.id, a.org_id, a.mode, a.provider, e.revision, e.credential_id, NULL AS credential_source_id,
      a.revision AS current_revision, a.revoked_at AS account_revoked_at,
      NULL AS revoked_at, e.created_at AS updated_at, c.kek_version, c.iv, c.wrapped_dek, c.ciphertext,
      r.credential_version_id AS pin_version_id, i.card_type
    FROM wallet_samsung_fetch_refs r
    JOIN wallet_provider_instances i ON i.id = r.instance_id
    JOIN wallet_provider_accounts a ON a.id = i.account_id AND a.org_id = i.org_id
      AND a.mode = i.mode AND a.provider = 'samsung'
    JOIN wallet_provider_account_events e ON e.account_id = a.id AND e.org_id = a.org_id
      AND e.mode = a.mode AND e.provider = a.provider AND e.revision = ? AND e.kind = 'configure'
    JOIN wallet_provider_credentials c ON c.id = e.credential_id AND c.account_id = a.id
      AND c.org_id = a.org_id AND c.mode = a.mode AND c.provider = a.provider
    WHERE r.ref_hash = ? AND i.org_id = ? AND i.mode = ? AND i.account_id = ?
      AND r.credential_keyset_commitment = ${pinnedKeysetSql}
      AND (? = 0 OR EXISTS (SELECT 1 FROM wallet_provider_instance_operations o
        WHERE o.instance_id = i.id AND o.account_revision = e.revision))`,
    [
      input.accountRevision,
      input.refHash,
      input.orgId,
      input.mode,
      input.accountId,
      input.operated ? 1 : 0,
    ],
  );
}
