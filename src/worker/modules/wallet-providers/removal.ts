import type { RemovalWallet } from '../../../shared/copy/removal.ts';
import type { Pass } from '../passes/repo.ts';
import { getWalletInstance } from './instance.ts';
import { walletProviderEnabled } from './provider-policy.ts';

/**
 * The wallets a removal reaches. Apple always: registered devices fetch the voided version.
 * Google and Samsung only when released and the pass has a live copy there; their revoke runs
 * from the pass's own lifecycle, so this only describes it.
 */
export async function removalWallets(db: D1Database, pass: Pass): Promise<RemovalWallet[]> {
  const wallets: RemovalWallet[] = ['apple'];
  for (const provider of ['google', 'samsung'] as const) {
    if (!walletProviderEnabled(provider)) continue;
    const instance = await getWalletInstance(db, {
      orgId: pass.orgId,
      mode: pass.mode,
      provider,
      passId: pass.id,
    });
    if (instance?.lifecycle === 'active') wallets.push(provider);
  }
  return wallets;
}
