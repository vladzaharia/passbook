import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { MODE_HEADER } from '@/shared/contracts/common.ts';
import { CapturedEmailDetailSchema, CapturedEmailListSchema } from '@/shared/contracts/sandbox.ts';
import type { InboxHost } from './host.ts';

export const inboxKeys = {
  all: ['test-inbox'] as const,
  list: (host: Pick<InboxHost, 'orgId' | 'mode' | 'userId' | 'key'>) =>
    [...inboxKeys.all, 'list', host.orgId ?? null, host.mode, host.userId, ...host.key] as const,
  detail: (
    id: string,
    orgId: string,
    mode: string,
    userId: string | undefined,
    scope: readonly string[] = [],
  ) => ['test-inbox', 'detail', id, orgId, mode, userId, ...scope] as const,
  forward: (id: string) => ['test-inbox', 'forward', id] as const,
  verifiedEmails: (userId: string | undefined) =>
    ['test-inbox', 'verified-emails', userId] as const,
};

export const inboxPath = (id: string) => `/api/v1/test-inbox/${encodeURIComponent(id)}`;

export function useCapturedEmails(host: InboxHost) {
  const { orgId, api, mode } = host;
  const allowed = Boolean(mode === 'test' && host.canRead && orgId);
  return useInfiniteQuery({
    queryKey: inboxKeys.list(host),
    enabled: allowed,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      if (!allowed || !orgId || host.modeNow() !== 'test') {
        throw new Error('Choose an authorized organization in Test mode.');
      }
      const page = await api.get('/api/v1/test-inbox', CapturedEmailListSchema, {
        query: { orgId, cursor: pageParam, limit: 50 },
        headers: { [MODE_HEADER]: 'test' },
        signal,
      });
      if (page.items.some((item) => item.orgId !== orgId)) {
        throw new Error('The inbox response did not match the selected organization.');
      }
      return page;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: 'always',
  });
}

export function useCapturedEmail(id: string, orgId: string, host: InboxHost) {
  const { api, mode } = host;
  const allowed = Boolean(mode === 'test' && host.canRead && host.orgId === orgId);
  return useQuery({
    queryKey: inboxKeys.detail(id, orgId, mode, host.userId, host.key),
    enabled: allowed,
    staleTime: 0,
    gcTime: 0,
    // Revalidation must fail closed rather than pause with an old sendable state.
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      if (!allowed || host.modeNow() !== 'test') {
        throw new Error('Choose an authorized organization in Test mode.');
      }
      const email = await api.get(inboxPath(id), CapturedEmailDetailSchema, {
        query: { orgId },
        headers: { [MODE_HEADER]: 'test' },
        signal,
      });
      if (email.orgId !== orgId) {
        throw new Error('The email did not match the selected organization.');
      }
      return email;
    },
  });
}

/** Verification is per principal; never reuse a previous user's account-email response. */
export function useVerifiedInboxEmails(host: InboxHost, enabled: boolean) {
  const { userId } = host;
  return useQuery({
    queryKey: inboxKeys.verifiedEmails(userId),
    enabled: enabled && Boolean(userId),
    queryFn: ({ signal }) => host.accountEmails(signal),
    staleTime: 0,
    gcTime: 0,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
  });
}
