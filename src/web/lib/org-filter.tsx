import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type OrgMembership, OrgMembershipListSchema } from '@/shared/contracts/org-membership.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { api } from './api.ts';
import { canAccessAdminPath } from './guards.ts';
import { firstAllowedPath } from './nav.ts';
import { type AdminScope, PLATFORM, parseAdminPath, switchTarget, withOrg } from './scope.ts';
import { membershipsQuery, sessionQuery, useMemberships, useSession } from './session.ts';

const NO_MEMBERSHIPS: OrgMembership[] = [];

function activeMemberships(items: OrgMembership[] | undefined, userId: string | undefined) {
  return userId
    ? (items?.filter((m) => m.userId === userId && m.revokedAt === null) ?? NO_MEMBERSHIPS)
    : NO_MEMBERSHIPS;
}

/** The scope the URL names: /admin/platform/... or /admin/o/$orgId/.... */
export function useAdminScope(): AdminScope | undefined {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return useMemo(() => parseAdminPath(pathname).scope, [pathname]);
}

/** The organization in the URL is not a grant: only the principal's active membership counts. */
export function useOrgScope() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const scope = useMemo(() => parseAdminPath(pathname).scope, [pathname]);
  const pathOrgId = scope?.kind === 'org' ? scope.orgId : undefined;
  const query = useMemberships();
  const session = useSession();
  const { authed, isAdmin } = session;
  const userId = authed?.user.id;
  // Grants stay usable while a refresh runs or fails: only the first load, or a principal
  // change that evicts the cache, makes them unavailable. Otherwise open dialogs would unmount.
  const sessionFailed = session.isError && session.session === undefined;
  const failed = sessionFailed || (query.isError && query.data === undefined);
  const unavailable = failed || query.data === undefined || session.session === undefined;
  const needsRefresh = Boolean(
    userId &&
      query.isStale &&
      !query.isFetching &&
      !query.isError &&
      !session.isFetching &&
      !session.isError,
  );
  useEffect(() => {
    if (needsRefresh) void query.refetch({ cancelRefetch: false });
  }, [needsRefresh, query.refetch]);
  const memberships = useMemo(
    () => (unavailable ? NO_MEMBERSHIPS : activeMemberships(query.data?.items, userId)),
    [query.data, unavailable, userId],
  );
  const membership = memberships.find((m) => m.orgId === pathOrgId);
  /** Open another organization (or the platform, with undefined) at the matching section. */
  const setOrgId = useCallback(
    (next: string | undefined) => {
      if (next === undefined) {
        if (!isAdmin) return;
        void navigate({
          to: switchTarget(pathname, PLATFORM, (path) => canAccessAdminPath(path, true)),
        });
        return;
      }
      const selected = memberships.find((m) => m.orgId === next);
      if (!selected) return;
      const target: AdminScope = { kind: 'org', orgId: next };
      void navigate({
        to: switchTarget(
          pathname,
          target,
          (path) => canAccessAdminPath(path, isAdmin, selected),
          firstAllowedPath(target, isAdmin, selected),
        ),
      });
    },
    [isAdmin, memberships, navigate, pathname],
  );
  return {
    orgId: membership?.orgId,
    setOrgId,
    memberships,
    membership,
    /** The page is inside an organization scope. */
    hasExplicitOrg: pathOrgId !== undefined,
    requestedOrgId: pathOrgId,
    // The URL's choice is useful for comparing scopes, but is never a grant.
    requestedSelection: pathOrgId,
    isLoading: !failed && unavailable,
    /** Grants or session are being refreshed or are stale; what they say is still usable. */
    isRefreshing:
      !failed &&
      !unavailable &&
      (query.isFetching || query.isStale || session.isFetching || session.isStale),
    isError: failed,
    error: sessionFailed ? session.error : query.error,
    refetch: sessionFailed ? session.refetch : query.refetch,
  };
}

const NO_ORG = { orgId: undefined, membership: undefined, memberships: NO_MEMBERSHIPS } as const;

/**
 * For a flow that must not act on grants while they refresh (the new-pass wizard keeps its draft
 * but disables Next): the same scope, loading and without grants until they are fresh.
 */
export function useFreshOrgScope() {
  const scope = useOrgScope();
  return scope.isRefreshing ? { ...scope, ...NO_ORG, isLoading: true } : scope;
}

type ResourceValidation = { key: string; items?: OrgMembership[] };

/**
 * Verify a resource's actual owner with fresh grants. A resource of another organization the
 * principal may open moves the page there (same path, that organization); otherwise not found.
 */
export function useResourceOrg(
  resourceOrgId: string | null | undefined,
  allowShared = false,
): 'pending' | 'ready' | 'not-found' | 'choose-org' {
  const scope = useOrgScope();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const { authed, isAdmin } = useSession();
  const userId = authed?.user.id;
  const client = useQueryClient();
  const navigate = useNavigate();
  const shared = resourceOrgId === null && allowShared;
  const target = shared ? scope.orgId : (resourceOrgId ?? undefined);
  const targetPath = target ? withOrg(pathname, target) : undefined;
  const key = JSON.stringify([userId, pathname, resourceOrgId, target]);
  const [validation, setValidation] = useState<ResourceValidation>();

  useEffect(() => {
    if (!userId || resourceOrgId === undefined || !target) return;
    const controller = new AbortController();
    const priorUpdates = client.getQueryState(membershipsQuery.queryKey)?.dataUpdateCount ?? 0;
    void api
      .get('/api/v1/orgs/memberships/me', OrgMembershipListSchema, { signal: controller.signal })
      .then(
        (data) => {
          if (controller.signal.aborted) return;
          const session = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
          if (!session?.authenticated || session.user.id !== userId) return;
          if (data.items.some((membership) => membership.userId !== userId)) {
            setValidation({ key });
            return;
          }
          const current = client.getQueryState(membershipsQuery.queryKey);
          if (
            (current?.dataUpdateCount ?? 0) === priorUpdates &&
            current?.fetchStatus !== 'fetching'
          ) {
            client.setQueryData(membershipsQuery.queryKey, data);
          }
          setValidation({ key, items: data.items });
        },
        () => {
          if (!controller.signal.aborted) setValidation({ key });
        },
      );
    return () => controller.abort();
  }, [client, key, resourceOrgId, target, userId]);

  const checked = validation?.key === key ? validation : undefined;
  const fresh = checked?.items?.find(
    (m) => m.orgId === target && m.userId === userId && m.revokedAt === null,
  );
  const current = scope.memberships.find((m) => m.orgId === target);
  const allowed = Boolean(
    targetPath &&
      fresh &&
      current &&
      canAccessAdminPath(targetPath, isAdmin, fresh) &&
      canAccessAdminPath(targetPath, isAdmin, current),
  );
  const moving = allowed && target !== scope.requestedOrgId;

  useEffect(() => {
    if (moving && targetPath) void navigate({ href: `${targetPath}${searchStr}`, replace: true });
  }, [moving, navigate, searchStr, targetPath]);

  if (scope.isLoading || resourceOrgId === undefined) return 'pending';
  if (scope.isError || (resourceOrgId === null && !allowShared)) return 'not-found';
  if (shared && !target) return scope.hasExplicitOrg ? 'not-found' : 'choose-org';
  if (!checked) return 'pending';
  if (!allowed) return 'not-found';
  return moving ? 'pending' : 'ready';
}
