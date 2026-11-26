import type { WalletProvider } from './instance-types.ts';

export type WalletReleaseMode = 'live' | 'test';
export type WalletReleaseState = 'dark' | 'draining' | 'released';

/**
 * The platform release of Google and Samsung per mode: the only place it is decided (provider-policy.ts reads it).
 * `wallet_provider_releases` mirrors it for the database's issuance guards (migration 0226); release-mirror.test.ts
 * and tools/check-migrations.ts fail when the two differ. A flip changes one cell and adds one migration that
 * updates the same row (docs/operations.md, "Wallet release").
 *
 * - `dark`: nothing issues, updates or calls out.
 * - `released`: an org issues when its plan includes the wallet and its enrolment is On.
 * - `draining`: the rollback. Nothing new issues and nothing updates; revokes (void, removal, transfer,
 *   retirement) still reach copies already in wallets. `dark` again only once every copy is retired.
 */
export const RELEASE: Record<WalletProvider, Record<WalletReleaseMode, WalletReleaseState>> = {
  google: { live: 'dark', test: 'dark' },
  samsung: { live: 'dark', test: 'dark' },
};
