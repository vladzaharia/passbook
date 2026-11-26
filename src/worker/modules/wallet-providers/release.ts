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
 *
 * Frozen: nothing changes it at run time. Tests and the e2e release override the policy's view of it
 * (`setWalletReleaseForTest` in provider-policy.ts), never this object.
 */
export const RELEASE: Readonly<
  Record<WalletProvider, Readonly<Record<WalletReleaseMode, WalletReleaseState>>>
> = Object.freeze({
  google: Object.freeze({ live: 'dark', test: 'dark' }),
  samsung: Object.freeze({ live: 'dark', test: 'dark' }),
});
