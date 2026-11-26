// Deploy checks for the wallet release (docs/operations.md, "Wallet release"). Each takes the remote query as a
// function, so the deploy tool owns every wrangler call.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pendingReleaseWrites } from './wallet-release-sql.ts';

/** Copies that can still be in a wallet, by provider and mode (0226 `wallet_provider_releases_dark_retired`). */
export const OPEN_COPIES_SQL = `SELECT provider, mode, COUNT(*) AS open FROM wallet_provider_instances
WHERE lifecycle IN ('active', 'revoking', 'revoked') OR (account_id IS NOT NULL AND lifecycle != 'retired')
GROUP BY provider, mode`;
export const RELEASED_SQL =
  "SELECT provider, mode FROM wallet_provider_releases WHERE state = 'released'";

/** The rows of a `wrangler d1 execute --json` result; throws on any other output (unreadable is never "none"). */
export function resultRows<T>(output: string): T[] {
  const parsed: unknown = JSON.parse(output);
  const rows: unknown = Array.isArray(parsed) ? parsed[0]?.results : undefined;
  if (!Array.isArray(rows)) throw new Error('Unexpected wrangler output; not deploying.');
  return rows as T[];
}

/**
 * Before migrating. Null to go on, else why not: the pending list could not be read (fails closed in every stage),
 * or a pending migration sets a provider and mode dark while copies of it can still be in wallets. Every pending
 * release write is logged; a flip (a write to `released`) turns on `--require-wallet-migrated`.
 */
export function walletReleaseRefusal(input: {
  root: string;
  pending: readonly string[] | null;
  log: (line: string) => void;
  remote: (sql: string) => string;
  flags: Set<string>;
}): string | null {
  if (input.pending === null)
    return 'Not deploying: the pending migrations could not be read, so a wallet release change cannot be ruled out.';
  const writes = pendingReleaseWrites(input.pending, (name) =>
    readFileSync(resolve(input.root, 'migrations', name), 'utf8'),
  );
  for (const w of writes)
    input.log(`Wallet release: ${w.provider} ${w.mode} -> ${w.state} (${w.migration})`);
  if (writes.some((w) => w.state === 'released')) input.flags.add('--require-wallet-migrated');
  const dark = writes.filter((w) => w.kind === 'update' && w.state === 'dark');
  if (dark.length === 0) return null;
  const open = resultRows<{ provider: string; mode: string; open: number }>(
    input.remote(OPEN_COPIES_SQL),
  );
  for (const w of dark) {
    const n = open.find((r) => r.provider === w.provider && r.mode === w.mode)?.open ?? 0;
    if (n > 0)
      return `Not deploying: ${w.migration} sets ${w.provider} ${w.mode} dark while ${n} copies can still be in wallets. Nothing has run. Void or remove those copies (readiness report, instances.open) and deploy again; a dark PR merges only at 0 (docs/operations.md, Wallet release).`;
  }
  return null;
}

/** Before serving: any released provider and mode needs every wallet account on a credential source. */
export function anyWalletReleased(remote: (sql: string) => string): boolean {
  return resultRows(remote(RELEASED_SQL)).length > 0;
}
