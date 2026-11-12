import { useQuery } from '@tanstack/react-query';
import { OrgMembershipListSchema } from '../../../shared/contracts/org-membership.ts';
import { api } from '../../lib/api.ts';

/** The launcher is available only while this user has current scanning-management membership. */
export function useScanManageAccess(userId: string | undefined): boolean {
  const memberships = useQuery({
    queryKey: ['scan', 'admin-orgs', userId],
    queryFn: ({ signal }) =>
      api.get('/api/v1/orgs/memberships/me', OrgMembershipListSchema, { signal }),
    enabled: !!userId,
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return (
    !!userId &&
    memberships.isSuccess &&
    memberships.isFetchedAfterMount &&
    !memberships.isFetching &&
    memberships.data.items.some(
      (membership) =>
        membership.userId === userId &&
        membership.revokedAt === null &&
        membership.capabilities.includes('scanning:manage'),
    )
  );
}
