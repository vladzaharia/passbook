// The database side of the release (wallet_provider_releases, 0229) for a test that opens the code side with
// setWalletProvidersEnabledForTest or setWalletReleaseForTest and keeps the guards in place.
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { run } from '../../platform/db.ts';
import type { WalletReleaseState } from './release.ts';

/** Every provider and mode back to dark, though copies exist: for a test of what the database refuses while dark. */
export const darkRows = (db: D1Database) =>
  withoutTrigger(db, 'wallet_provider_releases_dark_retired', () => releaseRows(db, 'dark'));

/** Every provider and mode to `state` (default released) in this test file's database. */
export async function releaseRows(db: D1Database, state: WalletReleaseState = 'released') {
  await run(db, 'UPDATE wallet_provider_releases SET state = ?, changed_at = 0', [state]);
}
