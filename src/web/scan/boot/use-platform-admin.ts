import { useQuery } from '@tanstack/react-query';
import { SessionResponseSchema } from '../../../shared/contracts/session.ts';
import { api } from '../../lib/api.ts';

/** UI visibility follows the platform session; a pairing credential never grants admin access. */
export function usePlatformAdmin() {
  const query = useQuery({
    queryKey: ['scan', 'platform-session'],
    queryFn: ({ signal }) => api.get('/api/v1/session', SessionResponseSchema, { signal }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const admin = query.data?.authenticated && query.data.roles.includes('admin') ? query.data : null;
  return { admin, pending: query.isPending };
}
