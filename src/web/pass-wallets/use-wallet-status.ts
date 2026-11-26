import { useQuery } from '@tanstack/react-query';
import type { PassDetailDto } from '@/shared/contracts/passes.ts';
import { WalletProviderPassStatusSchema } from '@/shared/contracts/wallet-provider-status.ts';
import { api } from '../lib/api.ts';
import { useMode } from '../lib/mode.ts';
import { useOrgScope } from '../lib/org-filter.tsx';
import { useSession } from '../lib/session.ts';

/** The pass's provider instances, read only for a member who may read passes, in the pass's mode. */
export function useWalletProviderStatus(
  pass: Pick<PassDetailDto, 'id' | 'orgId' | 'mode'>,
  active: boolean,
) {
  const scope = useOrgScope();
  const session = useSession();
  const mode = useMode();
  const userId = session.authed?.user.id;
  const allowed = Boolean(
    userId &&
      !session.isFetching &&
      !session.isError &&
      !scope.isLoading &&
      !scope.isError &&
      scope.orgId === pass.orgId &&
      scope.membership?.userId === userId &&
      scope.membership?.capabilities.includes('passes:read'),
  );
  const enabled = active && allowed && mode === pass.mode;
  const query = useQuery({
    queryKey: [
      'admin',
      'wallet-provider-status',
      pass.orgId,
      pass.mode,
      pass.id,
      userId,
      scope.membership?.id,
    ],
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/wallet-providers/passes/${encodeURIComponent(pass.id)}`,
        WalletProviderPassStatusSchema,
        { signal },
      ),
    enabled,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: enabled ? 15_000 : false,
  });
  return { query, allowed, mode };
}
