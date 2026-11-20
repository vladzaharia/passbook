import type { RemovalWallet } from '../../../shared/copy/removal.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { channelOn } from '../channels/gate.ts';
import type { Pass } from '../passes/repo.ts';
import { getWalletInstance } from './instance.ts';
import { walletProviderEnabled } from './provider-policy.ts';

/**
 * The wallets a removal reaches. Apple always: registered devices fetch the voided version.
 * Google and Samsung only when released, on for the org, and the pass has a live copy there; their revoke runs
 * from the pass's own lifecycle, so this only describes it.
 */
export async function removalWallets(ctx: ServiceContext, pass: Pass): Promise<RemovalWallet[]> {
  const wallets: RemovalWallet[] = ['apple'];
  for (const provider of ['google', 'samsung'] as const) {
    // Released, and effectively on for this pass's org (enrolment, block, template, pass).
    if (!walletProviderEnabled(provider) || !(await channelOn(ctx, pass, provider))) continue;
    const instance = await getWalletInstance(ctx.env.DB, {
      orgId: pass.orgId,
      mode: pass.mode,
      provider,
      passId: pass.id,
    });
    if (instance?.lifecycle === 'active') wallets.push(provider);
  }
  return wallets;
}
