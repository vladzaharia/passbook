import { useMemo } from 'react';
import { MyEmailListSchema } from '@/shared/contracts/me.ts';
import { type InboxHost, useInboxHost } from '../../admin/test-inbox/host.ts';
import { useMemberships, useSession } from '../../lib/session.ts';
import { sessionJson } from '../host/session-fetch.ts';
import { useToolHost } from '../host/tool-host.tsx';

/** Test mode is the only mode here: the scope pins it, and nothing reads the admin's switch. */
const io = {
  // The person's own addresses are account-level: the session answers, the token does not.
  accountEmails: (signal: AbortSignal) =>
    sessionJson('/api/v1/me/emails', MyEmailListSchema, { signal }),
  modeNow: () => 'test' as const,
};

/** The Workbench's host for the shared inbox: the context's org, the token client, Test. */
export function useWorkbenchInboxHost(): InboxHost {
  const { context } = useToolHost();
  const memberships = useMemberships();
  const userId = useSession().authed?.user.id;
  const membership = useMemo(
    () =>
      memberships.data?.items.find(
        (m) => m.orgId === context.orgId && m.userId === userId && m.revokedAt === null,
      ),
    [memberships.data, context.orgId, userId],
  );
  return useInboxHost(
    { orgId: context.orgId, membership, ready: memberships.data !== undefined },
    io,
  );
}
