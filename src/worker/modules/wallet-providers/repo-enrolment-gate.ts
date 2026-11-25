import { first } from '../../platform/db.ts';
import { notPreviewOnlySql } from '../developer/repo-fence.ts';
import type { WalletProvider } from './instance-types.ts';

export interface EnrolmentGateRow {
  credential_id: string | null;
  credential_source_id?: string | null;
  enabled_at?: number | null;
  platform_hold_at?: number | null;
  revoked_at: number | null;
}

export function findEnrolmentGateRow(
  db: D1Database,
  provider: WalletProvider,
  orgId: string,
  mode: 'live' | 'test',
): Promise<EnrolmentGateRow | null> {
  return first<EnrolmentGateRow>(
    db,
    `SELECT credential_id, credential_source_id, enabled_at, platform_hold_at, revoked_at FROM wallet_provider_accounts
     WHERE org_id = ? AND mode = ? AND provider = ?`,
    [orgId, mode, provider],
  );
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** Whether the org's plan includes the provider's wallet (`wallet.<provider>`). No row denies. */
export async function walletEntitled(
  db: D1Database,
  provider: WalletProvider,
  orgId: string,
): Promise<boolean> {
  // A developer org's plan never includes a wallet, whatever an override says.
  const row = await first<{ value: string }>(
    db,
    `SELECT v.value FROM org_entitlement_values v JOIN orgs o ON o.id = v.org_id
     WHERE v.org_id = ? AND v.key = ? AND o.kind != 'developer'`,
    [orgId, `wallet.${provider}`],
  );
  return row?.value === '1';
}

/**
 * Trusted SQL predicate for the org layer: the (org, mode, provider) enrolment may issue and the org's plan
 * includes the provider (`wallet.<provider>`; no row denies).
 */
export function walletEnrolmentIssuesSql(
  orgSql: string,
  modeSql: string,
  providerSql: string,
): string {
  if (![orgSql, modeSql, providerSql].every((x) => IDENT.test(x)))
    throw new Error('Invalid trusted wallet enrolment identifier');
  return `EXISTS (SELECT 1 FROM wallet_provider_accounts gate_a WHERE gate_a.org_id = ${orgSql}
    AND gate_a.mode = ${modeSql} AND gate_a.provider = ${providerSql}
    AND gate_a.revoked_at IS NULL AND gate_a.platform_hold_at IS NULL
    AND ((gate_a.credential_id IS NOT NULL AND gate_a.credential_source_id IS NULL) OR gate_a.enabled_at IS NOT NULL))
    AND EXISTS (SELECT 1 FROM org_entitlement_values gate_e WHERE gate_e.org_id = ${orgSql}
    AND gate_e.key = 'wallet.' || ${providerSql} AND gate_e.value = '1')
    AND ${notPreviewOnlySql(orgSql)}`;
}
