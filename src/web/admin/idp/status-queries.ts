import { useQuery } from '@tanstack/react-query';
import { IdpStatusSchema } from '@/shared/contracts/idp-access.ts';
import { api } from '@/web/lib/api.ts';
import { useSession } from '@/web/lib/session.ts';

export const IDP_KEY = ['idp'] as const;

/** Polaris ID as the binding reports it. Platform admins only: nobody else may ask. Each read costs the binding a health call. */
export function useIdpStatus({ staleMs = 30_000, enabled = true } = {}) {
  const { isAdmin } = useSession();
  return useQuery({
    queryKey: [...IDP_KEY, 'status'],
    queryFn: ({ signal }) => api.get('/api/v1/platform/idp', IdpStatusSchema, { signal }),
    enabled: enabled && isAdmin,
    staleTime: staleMs,
    refetchOnWindowFocus: staleMs < 60_000,
    retry: false,
  });
}

/**
 * Every Polaris ID surface hides unless this is true: false while the binding is absent, not
 * reachable, or not yet asked.
 */
export function useIdpConnected(): boolean {
  return useIdpStatus({ staleMs: 5 * 60_000 }).data?.connected === true;
}
