import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvent } from '../events/record.ts';
import type { WalletProvider } from './instance-types.ts';

/**
 * A provider's own report that the holder saved or removed the pass. The ledger shows it; it never
 * proves installation (see WalletProviderInstanceStatus.installation). Callers pass each receipt once.
 */
export async function recordWalletHolderEvent(
  ctx: ServiceContext,
  input: {
    orgId: string;
    passId: string;
    mode: Mode;
    provider: WalletProvider;
    event: 'saved' | 'removed';
  },
): Promise<void> {
  await recordPassEvent(ctx, {
    orgId: input.orgId,
    passId: input.passId,
    mode: input.mode,
    kind: input.event === 'saved' ? 'wallet.saved' : 'wallet.removed',
    actor: { type: 'system', id: null },
    data: { provider: input.provider },
  });
}
