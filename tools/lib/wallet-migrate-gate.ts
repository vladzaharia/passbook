// The PE3 gate: a deploy that needs every wallet account on a credential source refuses while one has none.

export interface UnmigratedWalletAccount {
  id: string;
  org_id: string;
  mode: string;
  provider: string;
}

/**
 * The rows of the `wallet-migration-gate` query from `wrangler d1 execute --json` output. Throws on any other
 * output: unreadable is never "nothing waiting".
 */
export function unmigratedWalletAccounts(output: string): UnmigratedWalletAccount[] {
  const parsed: unknown = JSON.parse(output);
  const rows: unknown = Array.isArray(parsed) ? parsed[0]?.results : undefined;
  if (
    !Array.isArray(rows) ||
    !rows.every((r) => r && typeof r === 'object' && typeof r.id === 'string' && 'org_id' in r)
  )
    throw new Error(
      'Unexpected wrangler output; cannot tell whether every wallet account is migrated.',
    );
  return rows as UnmigratedWalletAccount[];
}

export function walletMigrationRefusal(rows: readonly UnmigratedWalletAccount[]): string | null {
  return rows.length === 0
    ? null
    : `Not deploying: ${rows.length} wallet account(s) have no credential source:\n${rows
        .map((r) => `- ${r.id} (org ${r.org_id}, ${r.mode} ${r.provider})`)
        .join('\n')}\nMigrate or resolve them (docs/operations.md, Wallet migration gate).`;
}
