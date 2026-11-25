/**
 * Presence, not issuance. An account has a credential on either model: a legacy envelope (`credential_id`) or a new-model
 * enrolment's source (`credential_source_id`). Every presence check goes through these two forms.
 * Whether the account may issue is a separate gate: `walletEnrolmentIssues` (enabled, not held or revoked)
 * and, for a new-model source, the `activeOnly` source read in account-credential-source.ts.
 */
export function hasCredential(row: {
  credential_id: string | null;
  credential_source_id: string | null;
}): boolean {
  return row.credential_id !== null || row.credential_source_id !== null;
}

/** SQL form of `hasCredential`, one expression so a fence's depth ceiling is unchanged. */
export function hasCredentialSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error('Invalid trusted SQL alias');
  return `COALESCE(${alias}.credential_id, ${alias}.credential_source_id) IS NOT NULL`;
}
