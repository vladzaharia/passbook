import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DeveloperInvitationListSchema,
  DeveloperListSchema,
} from '@/shared/contracts/developer-invitations.ts';
import { api } from '@/web/lib/api.ts';

/** Developers and their pending invitations; `available` false hides the section. */
export function useDevelopers(orgId: string) {
  const path = `/api/v1/orgs/${encodeURIComponent(orgId)}`;
  const key = ['org-access', orgId];
  const client = useQueryClient();
  const developers = useQuery({
    queryKey: [...key, 'developers'],
    queryFn: ({ signal }) => api.get(`${path}/developers`, DeveloperListSchema, { signal }),
    retry: false,
  });
  const available = developers.data?.available === true;
  const invitations = useQuery({
    queryKey: [...key, 'developer-invitations'],
    enabled: available,
    queryFn: ({ signal }) =>
      api.get(`${path}/developer-invitations`, DeveloperInvitationListSchema, { signal }),
  });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  return {
    developers,
    invitations,
    available,
    remove: useMutation({
      mutationFn: (userId: string) =>
        api.delete(`${path}/developers/${encodeURIComponent(userId)}`),
      onSettled: refresh,
    }),
    revoke: useMutation({
      mutationFn: (id: string) =>
        api.delete(`${path}/developer-invitations/${encodeURIComponent(id)}`),
      onSettled: refresh,
    }),
  };
}
