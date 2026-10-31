import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OkSchema } from '@/shared/contracts/common.ts';
import { UserDetailSchema, UserListSchema, UserSchema } from '@/shared/contracts/users.ts';
import { api } from '@/web/lib/api.ts';

export interface UserFilters {
  q?: string | undefined;
  status?: 'active' | 'disabled' | undefined;
}

export function useUserList(filters: UserFilters) {
  return useInfiniteQuery({
    queryKey: ['users', 'list', filters.q ?? '', filters.status ?? ''],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/v1/users', UserListSchema, {
        query: { q: filters.q, status: filters.status, cursor: pageParam, limit: 50 },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

const detailKey = (id: string) => ['users', 'detail', id] as const;
const path = (id: string) => `/api/v1/users/${encodeURIComponent(id)}`;

export function useUser(id: string) {
  return useQuery({
    queryKey: detailKey(id),
    queryFn: ({ signal }) => api.get(path(id), UserDetailSchema, { signal }),
  });
}

export function useUserMutations(id: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['users'] });
  return {
    setStatus: useMutation({
      mutationFn: (status: 'active' | 'disabled') => api.patch(path(id), UserSchema, { status }),
      onSuccess: refresh,
    }),
    revokeSessions: useMutation({
      mutationFn: () => api.post(`${path(id)}/sessions/revoke`, OkSchema),
      onSuccess: refresh,
    }),
    addEmail: useMutation({
      mutationFn: (email: string) => api.post(`${path(id)}/emails`, UserDetailSchema, { email }),
      onSuccess: (data) => client.setQueryData(detailKey(id), data),
    }),
    removeEmail: useMutation({
      mutationFn: (email: string) => api.delete(`${path(id)}/emails/${encodeURIComponent(email)}`),
      onSuccess: () => client.invalidateQueries({ queryKey: detailKey(id) }),
    }),
  };
}
