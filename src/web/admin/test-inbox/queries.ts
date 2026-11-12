import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { MODE_HEADER } from '@/shared/contracts/common.ts';
import { MyEmailListSchema } from '@/shared/contracts/me.ts';
import type { OrgMembershipListSchema } from '@/shared/contracts/org-membership.ts';
import {
  CapturedEmailDetailSchema,
  CapturedEmailListSchema,
  SentToMeSchema,
} from '@/shared/contracts/sandbox.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { api } from '@/web/lib/api.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { getMode, useMode } from '@/web/lib/mode.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { membershipsQuery, sessionQuery, useMemberships, useSession } from '@/web/lib/session.ts';

import { FENCE_GRACE, FENCE_TTL, type LocalOutcome, readFence, writeFence } from './send-fence.ts';

export const inboxKeys = {
  all: ['test-inbox'] as const,
  detail: (id: string, orgId: string, mode: string, userId: string | undefined) =>
    ['test-inbox', 'detail', id, orgId, mode, userId] as const,
  forward: (id: string) => ['test-inbox', 'forward', id] as const,
  verifiedEmails: (userId: string | undefined) =>
    ['test-inbox', 'verified-emails', userId] as const,
};

const path = (id: string) => `/api/v1/test-inbox/${encodeURIComponent(id)}`;

export function useCapturedEmails(orgId: string | undefined) {
  const mode = useMode();
  const scope = useOrgScope();
  const { isError, isFetching, authed } = useSession();
  const memberships = useMemberships();
  const allowed = Boolean(
    mode === 'test' &&
      !isError &&
      !isFetching &&
      authed &&
      !scope.isLoading &&
      !scope.isError &&
      !memberships.isFetching &&
      orgId &&
      orgId === scope.orgId &&
      scope.membership &&
      scope.membership.userId === authed?.user.id &&
      scope.membership.capabilities.includes('passes:read'),
  );
  return useInfiniteQuery({
    queryKey: [...inboxKeys.all, 'list', orgId ?? null, mode, authed?.user.id],
    enabled: allowed,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      if (!allowed || !orgId || getMode() !== 'test') {
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

export function useCapturedEmail(id: string, orgId: string) {
  const mode = useMode();
  const scope = useOrgScope();
  const { isError, isFetching, authed } = useSession();
  const memberships = useMemberships();
  const allowed = Boolean(
    mode === 'test' &&
      !isError &&
      !isFetching &&
      authed &&
      !scope.isLoading &&
      !scope.isError &&
      !memberships.isFetching &&
      scope.orgId === orgId &&
      scope.membership &&
      scope.membership.userId === authed?.user.id &&
      scope.membership.capabilities.includes('passes:read'),
  );
  return useQuery({
    queryKey: inboxKeys.detail(id, orgId, mode, authed?.user.id),
    enabled: allowed,
    staleTime: 0,
    gcTime: 0,
    // Revalidation must fail closed rather than pause with an old sendable state.
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      if (!allowed || getMode() !== 'test') {
        throw new Error('Choose an authorized organization in Test mode.');
      }
      const email = await api.get(path(id), CapturedEmailDetailSchema, {
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
export function useVerifiedInboxEmails(userId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: inboxKeys.verifiedEmails(userId),
    enabled: enabled && Boolean(userId),
    queryFn: ({ signal }) => api.get('/api/v1/me/emails', MyEmailListSchema, { signal }),
    staleTime: 0,
    gcTime: 0,
    networkMode: 'always',
    refetchOnWindowFocus: 'always',
  });
}

export interface InboxSendScope {
  active: boolean;
  requests: Set<AbortController>;
}

class SendNotAllowed extends Error {}

function failureOutcome(error: unknown): LocalOutcome | undefined {
  if (error instanceof SendNotAllowed) return undefined;
  if (isApiError(error)) {
    if (
      (error.status === 422 &&
        (error.code === 'NO_VERIFIED_EMAIL' || error.code === 'NOT_A_USER')) ||
      (error.status === 409 && error.code === 'TEST_FORWARD_CHANGED') ||
      (error.status === 429 && error.code === 'RATE_LIMITED') ||
      (error.status === 503 && error.code === 'RATE_LIMIT_UNAVAILABLE')
    ) {
      return undefined;
    }
    if (error.status === 503 && error.code === 'TEST_FORWARD_PREPARATION_FAILED') return 'prepared';
  }
  return 'unconfirmed';
}

export function useSendCapturedToMe(
  id: string,
  orgId: string,
  userId: string,
  canSend: boolean,
  sendScope: InboxSendScope,
  onAccepted: (to: string) => void,
  /** What the server last said about forwarding, and when it said it. */
  server: { forwarding: string | undefined; at: number },
) {
  const client = useQueryClient();
  const [stored, setStored] = useState(() => readFence(id));
  // Attempts submitted before this no longer count: the fence was released.
  const [releasedAt, setReleasedAt] = useState(0);
  const allowed = useRef(canSend);
  const controller = useRef<AbortController | undefined>(undefined);
  allowed.current = canSend;
  useEffect(() => {
    if (!canSend) controller.current?.abort();
  }, [canSend]);

  const authorized = () => {
    const session = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
    const memberships = client.getQueryData<z.infer<typeof OrgMembershipListSchema>>(
      membershipsQuery.queryKey,
    );
    const emailsKey = inboxKeys.verifiedEmails(userId);
    const emails = client.getQueryData<z.infer<typeof MyEmailListSchema>>(emailsKey);
    const emailState = client.getQueryState(emailsKey);
    const sessionState = client.getQueryState(sessionQuery.queryKey);
    const membershipState = client.getQueryState(membershipsQuery.queryKey);
    return Boolean(
      allowed.current &&
        getMode() === 'test' &&
        session?.authenticated &&
        session.user.id === userId &&
        sessionState?.status === 'success' &&
        sessionState.fetchStatus === 'idle' &&
        membershipState?.status === 'success' &&
        membershipState.fetchStatus === 'idle' &&
        memberships?.items.some(
          (m) =>
            m.orgId === orgId &&
            m.userId === userId &&
            m.revokedAt === null &&
            m.capabilities.includes('passes:read') &&
            m.capabilities.includes('passes:operate'),
        ) &&
        emailState?.status === 'success' &&
        emailState.fetchStatus === 'idle' &&
        emails?.items.some((email) => email.verifiedAt !== null && email.email.trim()),
    );
  };
  const save = (value: LocalOutcome | undefined) => {
    const fence = value === undefined ? undefined : { value, at: Date.now() };
    writeFence(id, fence);
    setStored(fence);
  };
  const key = inboxKeys.forward(id);
  const pending = useIsMutating({ mutationKey: key, exact: true }) > 0;
  const attempts = useMutationState({
    filters: { mutationKey: key, exact: true },
    select: ({ state }) => ({
      status: state.status,
      error: state.error,
      submittedAt: state.submittedAt,
    }),
  });
  const last = attempts.at(-1);
  const attempt = last && last.submittedAt > releasedAt ? last : undefined;
  const outcome =
    attempt?.status === 'success'
      ? 'accepted'
      : attempt?.status === 'error'
        ? failureOutcome(attempt.error)
        : stored?.value;
  // A fence the server has not confirmed lasts until the server shows no reservation (after a
  // grace for a request still in flight) or the TTL runs out, so a lost request cannot lock the
  // button for good.
  const since = Math.max(stored?.at ?? 0, attempt?.submittedAt ?? 0);
  const unresolved = outcome === 'unconfirmed' || outcome === 'prepared';
  const serverClear = server.forwarding === 'none' || server.forwarding === 'failed';
  useEffect(() => {
    if (!unresolved || pending) return;
    const release = () => {
      writeFence(id, undefined);
      setStored(undefined);
      setReleasedAt(Date.now());
    };
    const remaining = since + FENCE_TTL - Date.now();
    if (remaining <= 0 || (serverClear && server.at >= since + FENCE_GRACE)) {
      release();
      return;
    }
    const timer = setTimeout(release, remaining);
    return () => clearTimeout(timer);
  }, [unresolved, pending, since, serverClear, server.at, id]);
  const mutation = useMutation({
    mutationKey: key,
    onMutate: () => {
      if (!authorized() || !sendScope.active) {
        throw new SendNotAllowed('Sending is no longer allowed.');
      }
      save('unconfirmed');
    },
    mutationFn: async () => {
      if (!authorized() || !sendScope.active) {
        throw new SendNotAllowed('Sending is no longer allowed.');
      }
      const request = new AbortController();
      controller.current = request;
      sendScope.requests.add(request);
      try {
        const { to } = await api.post(`${path(id)}/send-to-me`, SentToMeSchema, undefined, {
          query: { orgId },
          headers: { [MODE_HEADER]: 'test' },
          signal: request.signal,
        });
        onAccepted(to);
        save('accepted');
      } finally {
        sendScope.requests.delete(request);
        if (controller.current === request) controller.current = undefined;
      }
    },
    retry: false,
    networkMode: 'always',
    // Keep the local ambiguity fence when the preview is closed and reopened.
    gcTime: Infinity,
    onError: (error) => {
      save(failureOutcome(error));
      if (isApiError(error) && error.code === 'NO_VERIFIED_EMAIL') {
        void client.invalidateQueries({ queryKey: inboxKeys.verifiedEmails(userId), exact: true });
      }
    },
    onSettled: () =>
      client.invalidateQueries({
        queryKey: inboxKeys.detail(id, orgId, 'test', userId),
        exact: true,
      }),
  });
  return {
    mutation,
    pending,
    accepted: outcome === 'accepted',
    prepared: outcome === 'prepared',
    unconfirmed: outcome === 'unconfirmed',
  };
}
