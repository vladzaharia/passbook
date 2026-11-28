import { entitlementsRestricted } from './authority-restricted/entitlements.ts';
import { nfcRestricted } from './authority-restricted/nfc.ts';
import type { RestrictedEntries } from './authority-restricted/types.ts';
import { walletRestricted } from './authority-restricted/wallet.ts';

/** One line per area file; a new package appends its own. */
const AREAS: readonly RestrictedEntries[] = [
  walletRestricted,
  entitlementsRestricted,
  nfcRestricted,
];

function assemble(pick: 'restricted' | 'insertOnly'): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, string[]> = {};
  for (const area of AREAS)
    for (const [table, purposes] of Object.entries(area[pick] ?? {}))
      out[table] = [...(out[table] ?? []), ...purposes];
  return out;
}

/**
 * Guarded tables only the listed purposes may write, whatever the principal or the grant's `tables`. The
 * credential check job is the one writer of a check: no org_mode or platform.wallet.* grant inserts one.
 */
export const RESTRICTED_TABLES = assemble('restricted');

/** Restricted purposes that may only insert into a table (no update, delete or upsert). */
export const INSERT_ONLY_PURPOSES = assemble('insertOnly');
