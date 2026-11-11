import { useQuery } from '@tanstack/react-query';
import { SessionResponseSchema } from '../../../shared/contracts/session.ts';
import { api } from '../../lib/api.ts';

/** A pairing credential alone does not grant access to the signed-in scanner entry. */
export function usePlatformSession() {
  const query = useQuery({
    queryKey: ['scan', 'platform-session'],
    queryFn: ({ signal }) => api.get('/api/v1/session', SessionResponseSchema, { signal }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return !query.isError && query.data?.authenticated ? query.data : null;
}
