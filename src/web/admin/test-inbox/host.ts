import { useEffect, useMemo } from 'react';
import type { z } from 'zod';
import type { Mode } from '@/shared/contracts/common.ts';
import type { MyEmailListSchema } from '@/shared/contracts/me.ts';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import { useMemberships, useSession } from '../../lib/session.ts';
import {
  type ToolApi,
  useToolApi,
  useToolKey,
  useToolMode,
  useToolScope,
} from '../../lib/tool-api.tsx';

/** What the send fence and the preview check against: abandoned when the principal, org or mode changes. */
export interface InboxSendScope {
  orgId: string | undefined;
  mode: Mode;
  userId: string | undefined;
  canOperate: boolean;
  active: boolean;
  requests: Set<AbortController>;
}

/** Which organization the host shows, and the person's membership in it. */
interface InboxWho {
  orgId: string | undefined;
  membership: OrgMembership | undefined;
  /** The memberships the host reads are loaded and current. */
  ready: boolean;
}

/** What only the host's own module may reach: the account read, and the mode when no scope pins it. */
export interface InboxIo {
  accountEmails: InboxHost['accountEmails'];
  /** The admin's mode switch, read at the moment of a send. A pinned scope answers for itself. */
  modeNow: () => Mode;
}

/**
 * Everything the inbox needs from where it runs (admin or the Workbench): the client, the mode,
 * the organization and what the person may do there, the cache scope, and the one account read.
 * The queries, the preview and the send fence take this and nothing else.
 */
export interface InboxHost {
  orgId: string | undefined;
  userId: string | undefined;
  mode: Mode;
  canRead: boolean;
  canOperate: boolean;
  api: ToolApi;
  /** Appended to every query key, so two hosts never share an entry. */
  key: readonly string[];
  /** The mode at the moment of a send, read outside render. */
  modeNow: () => Mode;
  /** The person's own verified addresses (account-level: not a tenant call). */
  accountEmails: (signal: AbortSignal) => Promise<z.infer<typeof MyEmailListSchema>>;
  authority: InboxSendScope;
}

/**
 * The host's shared rules once: reading needs `passes:read` in the shown org through the signed-in
 * person's own active membership, sending needs `passes:operate`, and nothing is allowed while the
 * session or memberships are loading or failed. The client, mode and cache scope come from the tool
 * scope: the session's in admin, the Workbench token's in the Workbench.
 */
export function useInboxHost(who: InboxWho, io: InboxIo): InboxHost {
  const session = useSession();
  const memberships = useMemberships();
  const api = useToolApi();
  const mode = useToolMode();
  const key = useToolKey();
  const pinned = useToolScope();
  const userId = session.authed?.user.id;
  const { orgId, membership } = who;
  const canRead = Boolean(
    !session.isError &&
      !session.isFetching &&
      userId &&
      who.ready &&
      !memberships.isFetching &&
      orgId &&
      membership &&
      membership.userId === userId &&
      membership.capabilities.includes('passes:read'),
  );
  const canOperate = Boolean(canRead && membership?.capabilities.includes('passes:operate'));
  // A new authority when the org, mode, person or send right changes: the old one is abandoned.
  const authority = useMemo<InboxSendScope>(
    () => ({ orgId, mode, userId, canOperate, active: true, requests: new Set<AbortController>() }),
    [orgId, mode, userId, canOperate],
  );
  useEffect(() => {
    authority.active = true;
    return () => {
      authority.active = false;
      for (const request of authority.requests) request.abort();
      authority.requests.clear();
    };
  }, [authority]);
  return {
    orgId,
    userId,
    mode,
    canRead,
    canOperate,
    api,
    key,
    modeNow: () => pinned?.mode ?? io.modeNow(),
    accountEmails: io.accountEmails,
    authority,
  };
}
