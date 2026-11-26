import type { RemovalWallet } from '../../../shared/copy/removal.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { channelOn } from '../channels/gate.ts';
import type { Pass } from '../passes/repo.ts';
import { getWalletInstance } from './instance.ts';
import { walletProviderRevokes } from './provider-policy.ts';

/**
 * The wallets a removal reaches. Apple always: registered devices fetch the voided version.
 * Google and Samsung when their revokes run (released or draining), the channel is on for the pass and it has a
 * live copy there; the revoke runs from the pass's own lifecycle, so this only describes it.
 */
export async function removalWallets(
  ctx: ServiceContext,
  pass: Pass,
  providers: readonly ('google' | 'samsung')[] = ['google', 'samsung'],
): Promise<RemovalWallet[]> {
  const wallets: RemovalWallet[] = ['apple'];
  for (const provider of providers) {
    // Revokes run released or draining, enrolled or held; the pass's channel must still be on.
    if (!walletProviderRevokes(provider, pass.mode) || !(await channelOn(ctx, pass, provider)))
      continue;
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
