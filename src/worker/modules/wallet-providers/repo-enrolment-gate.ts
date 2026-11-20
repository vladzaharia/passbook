import { first } from '../../platform/db.ts';
import type { WalletProvider } from './instance-types.ts';

export interface EnrolmentGateRow {
  credential_id: string | null;
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
    `SELECT credential_id, enabled_at, platform_hold_at, revoked_at FROM wallet_provider_accounts
     WHERE org_id = ? AND mode = ? AND provider = ?`,
    [orgId, mode, provider],
  );
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** Trusted SQL predicate for the org layer: the (org, mode, provider) enrolment may issue. */
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
    AND (gate_a.credential_id IS NOT NULL OR gate_a.enabled_at IS NOT NULL))`;
}
