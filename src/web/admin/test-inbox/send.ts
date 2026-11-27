import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { MODE_HEADER } from '@/shared/contracts/common.ts';
import type { MyEmailListSchema } from '@/shared/contracts/me.ts';
import type { OrgMembershipListSchema } from '@/shared/contracts/org-membership.ts';
import { SentToMeSchema } from '@/shared/contracts/sandbox.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { membershipsQuery, sessionQuery } from '@/web/lib/session.ts';
import type { InboxHost } from './host.ts';
import { inboxKeys, inboxPath as path } from './queries.ts';
import { FENCE_GRACE, FENCE_TTL, type LocalOutcome, readFence, writeFence } from './send-fence.ts';

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
  host: InboxHost,
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
        host.modeNow() === 'test' &&
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
      if (!authorized() || !host.authority.active) {
        throw new SendNotAllowed('Sending is no longer allowed.');
      }
      save('unconfirmed');
    },
    mutationFn: async () => {
      if (!authorized() || !host.authority.active) {
        throw new SendNotAllowed('Sending is no longer allowed.');
      }
      const request = new AbortController();
      controller.current = request;
      host.authority.requests.add(request);
      try {
        const { to } = await host.api.post(`${path(id)}/send-to-me`, SentToMeSchema, undefined, {
          query: { orgId },
          headers: { [MODE_HEADER]: 'test' },
          signal: request.signal,
        });
        onAccepted(to);
        save('accepted');
      } finally {
        host.authority.requests.delete(request);
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
        queryKey: inboxKeys.detail(id, orgId, 'test', userId, host.key),
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
