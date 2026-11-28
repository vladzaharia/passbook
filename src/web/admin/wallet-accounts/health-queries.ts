import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  WalletHealthListSchema,
  WalletRecheckResultSchema,
} from '@/shared/contracts/wallet-health.ts';
import type { WalletProvider } from '@/shared/contracts/wallet-providers.ts';
import { api } from '@/web/lib/api.ts';
import { useMode } from '@/web/lib/mode.ts';

const KEY = ['wallet-accounts', 'health'] as const;
const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/wallet-health`;
const REFRESH_MS = 15_000;

/** The wallets open to the org in the session mode, with the counts behind their health. */
export function useOrgWalletHealth(orgId: string) {
  const mode = useMode();
  return useQuery({
    queryKey: [...KEY, orgId, mode],
    queryFn: ({ signal }) => api.get(base(orgId), WalletHealthListSchema, { signal }),
    // Uncertain updates settle in the background: keep the count moving while any remain.
    refetchInterval: (q) => (q.state.data?.items.some((i) => i.uncertain > 0) ? REFRESH_MS : false),
  });
}

export function useWalletRecheck(orgId: string) {
  const client = useQueryClient();
  return async (provider: WalletProvider) => {
    const result = await api.post(
      `${base(orgId)}/${provider}/recheck`,
      WalletRecheckResultSchema,
      {},
    );
    await client.invalidateQueries({ queryKey: KEY });
    return result;
  };
}
