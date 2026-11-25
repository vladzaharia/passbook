import { all } from '../../platform/db.ts';

/** Codes that say the credentials themselves are bad; the rest (a timeout, a 5xx) say nothing about them. */
const DEFINITIVE = [
  'auth_failed',
  'issuer_not_found',
  'issuer_mismatch',
  'invalid_credentials',
  'cert_expired',
  'credential_unreadable',
  'card_not_active',
  'card_not_found',
];
export const isDefinitiveCheckFailure = (code: string | null): boolean =>
  code !== null && DEFINITIVE.includes(code);

/**
 * Whether the account's source credential is Failing: its two newest checks both failed on the credentials
 * (Q6). One unreachable provider, or one bad read, hides no badge; a failed check is rechecked within minutes
 * (`account-check.ts`), so a real fault shows on the second and a passing one clears it. An account with fewer
 * than two checks, or no source credential yet, is not failing.
 */
export async function accountCheckFailing(db: D1Database, accountId: string): Promise<boolean> {
  const rows = await all<{ ok: number; code: string | null }>(
    db,
    `SELECT c.ok, c.code FROM wallet_provider_accounts a
    JOIN wallet_credential_checks c ON c.credential_id = a.credential_source_id
    WHERE a.id = ? ORDER BY c.checked_at DESC, c.id DESC LIMIT 2`,
    [accountId],
  );
  return rows.length === 2 && rows.every((r) => r.ok === 0 && isDefinitiveCheckFailure(r.code));
}
