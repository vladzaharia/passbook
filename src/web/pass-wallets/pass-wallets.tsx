import { WalletCards } from 'lucide-react';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { Card, CardBody, CardHeader, ListRow, ListRows, StatusPill } from '../ui/index.ts';
import {
  recommendedProvider,
  releasedProviders,
  WALLET_STATE_LABEL,
  WALLET_STATE_TONE,
  walletState,
} from './states.ts';
import { useWalletProviderStatus } from './use-wallet-status.ts';

const NAME = { google: 'Google Wallet', samsung: 'Samsung Wallet' } as const;

/**
 * Where a pass stands in Google and Samsung Wallet: Not saved, Offered or Saved, and the likely wallet. Shared by
 * the admin pass page and the Workbench Passes tool. Nothing shows for a provider that is not released.
 */
export function PassWallets({ pass }: { pass: Pick<PassDetailDto, 'id' | 'orgId' | 'mode'> }) {
  const { query, allowed, mode } = useWalletProviderStatus(pass, true);
  if (!allowed || mode !== pass.mode || !query.data) return null;
  const shown = releasedProviders(query.data.providers);
  if (shown.length === 0) return null;
  const likely = recommendedProvider(shown);
  return (
    <Card className="min-w-0">
      <CardHeader title="Wallets" />
      <CardBody>
        <ListRows label="Wallets">
          {shown.map((status) => {
            const state = walletState(status);
            return (
              <ListRow
                key={status.provider}
                leading={<WalletCards aria-hidden />}
                title={NAME[status.provider]}
                pills={
                  <>
                    <StatusPill status={`wallet_${state}`} tone={WALLET_STATE_TONE[state]}>
                      {WALLET_STATE_LABEL[state]}
                    </StatusPill>
                    {likely === status.provider ? (
                      <StatusPill status="wallet_recommended" tone="info">
                        Recommended
                      </StatusPill>
                    ) : null}
                  </>
                }
              />
            );
          })}
        </ListRows>
      </CardBody>
    </Card>
  );
}
