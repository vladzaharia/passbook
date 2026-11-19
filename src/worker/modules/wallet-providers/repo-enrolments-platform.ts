import type { WalletProvider } from '../../../shared/contracts/wallet-providers.ts';
import { all } from '../../platform/db.ts';

export interface PlatformEnrolmentRow {
  org_id: string;
  org_name: string;
  mode: 'live' | 'test';
  provider: WalletProvider;
  source_scope: 'platform' | 'org' | null;
  enabled_at: number | null;
  platform_hold_at: number | null;
  platform_hold_reason: string | null;
  revoked_at: number | null;
  updated_at: number;
}

/** Every org's enrolment of one provider; rows that never picked a source are left out. */
export function platformEnrolmentRows(
  db: D1Database,
  provider: WalletProvider,
): Promise<PlatformEnrolmentRow[]> {
  return all<PlatformEnrolmentRow>(
    db,
    `SELECT a.org_id, o.name AS org_name, a.mode, a.provider, c.scope AS source_scope, a.enabled_at,
      a.platform_hold_at, a.platform_hold_reason, a.revoked_at, a.updated_at
     FROM wallet_provider_accounts a
     JOIN orgs o ON o.id = a.org_id
     LEFT JOIN wallet_credentials c ON c.id = a.credential_source_id
     WHERE a.provider = ? AND (a.credential_source_id IS NOT NULL OR a.revoked_at IS NOT NULL)
     ORDER BY o.name, a.org_id, a.mode`,
    [provider],
  );
}
