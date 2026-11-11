import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { type OrgMembership, OrgMembershipListSchema } from '@/shared/contracts/org-membership.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { api } from './api.ts';
import { canAccessAdminPath, isTenantResourceDetail } from './guards.ts';
import { isOrgScoped } from './nav.ts';
import { readRaw, readStored, store, subscribe } from './org-filter-store.ts';
import { clearOrgPreviewBatches } from './preview-batch.ts';
import { orgScopeSearchSchema } from './route-search.ts';
import { membershipsQuery, sessionQuery, useMemberships, useSession } from './session.ts';

const NO_MEMBERSHIPS: OrgMembership[] = [];
const WORKSPACES = ['/admin/passes', '/admin/templates', '/admin/connections', '/admin/scanning'];

function orgDetailId(pathname: string): string | undefined {
  const segment = /^\/admin\/orgs\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function useScopeLocation() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = useRouterState({ select: (state) => state.location.search });
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const values = new URLSearchParams(searchStr).getAll('orgId');
  const parsed = search.orgId;
  // Router JSON-decodes scalar IDs; reject objects and arrays, including duplicate parameters.
  const candidate =
    typeof parsed === 'string'
      ? parsed
      : parsed == null || typeof parsed === 'number' || typeof parsed === 'boolean'
        ? values[0]
        : undefined;
  const fromUrl =
    values.length === 1 ? orgScopeSearchSchema.parse({ orgId: candidate }).orgId : undefined;
  const detailId = orgDetailId(pathname);
  const workspace = Boolean(detailId && search.view === 'workspace');
  return {
    pathname,
    scoped: detailId ? workspace : isOrgScoped(pathname),
    fromUrl,
    hasExplicitOrg: values.length > 0,
    detailId,
    workspace,
  };
}

function activeMemberships(items: OrgMembership[] | undefined, userId: string | undefined) {
  return userId
    ? (items?.filter((m) => m.userId === userId && m.revokedAt === null) ?? NO_MEMBERSHIPS)
    : NO_MEMBERSHIPS;
}

/** Keep a validated workspace choice in the URL; an explicit invalid URL never uses storage. */
export function useOrgScopeUrl(): void {
  const navigate = useNavigate();
  const { pathname, scoped, fromUrl, hasExplicitOrg, workspace } = useScopeLocation();
  const remembered = useSyncExternalStore(subscribe, readStored, () => undefined);
  const query = useMemberships();
  const session = useSession();
  const userId = session.authed?.user.id;
  const scope = useOrgScope();
  const { memberships, orgId: selected } = scope;
  const unavailable = scope.isError || scope.isLoading;
  const previous = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (previous.current && previous.current !== selected) clearOrgPreviewBatches(previous.current);
    previous.current = selected;
  }, [selected]);

  useEffect(() => {
    if (!userId || !query.data || unavailable) return;
    const allowed = (id: string) => memberships.some((m) => m.orgId === id);
    if (scoped && hasExplicitOrg) {
      if (!fromUrl || !allowed(fromUrl)) {
        store(undefined);
      } else if (!isTenantResourceDetail(pathname, workspace ? 'workspace' : undefined)) {
        // Resource details remember their owner only after useResourceOrg verifies it.
        store(fromUrl);
      }
      return;
    }
    const raw = readRaw();
    if (raw !== undefined && (!remembered || !allowed(remembered))) {
      store(undefined);
      return;
    }
    // By-ID resources, including workspaces, adopt their actual owner after fresh verification.
    if (
      !remembered ||
      !scoped ||
      isTenantResourceDetail(pathname, workspace ? 'workspace' : undefined)
    )
      return;
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, orgId: remembered }),
      replace: true,
      resetScroll: false,
      ignoreBlocker: true,
    });
  }, [
    pathname,
    scoped,
    fromUrl,
    hasExplicitOrg,
    workspace,
    memberships,
    navigate,
    query.data,
    unavailable,
    remembered,
    userId,
  ]);
}

/** An organization choice is not a grant: only the current principal's active membership counts. */
export function useOrgScope() {
  const navigate = useNavigate();
  const { scoped, fromUrl, hasExplicitOrg, detailId, workspace } = useScopeLocation();
  const remembered = useSyncExternalStore(subscribe, readStored, () => undefined);
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
  const requested = scoped && hasExplicitOrg ? fromUrl : remembered;
  const membership = memberships.find(
    (m) => m.orgId === requested && (!workspace || fromUrl === detailId),
  );
  const orgId = membership?.orgId;
  const setOrgId = useCallback(
    (next: string | undefined) => {
      const selected = next ? memberships.find((m) => m.orgId === next) : undefined;
      if (next && !selected) return;
      if (orgId && orgId !== next) clearOrgPreviewBatches(orgId);
      store(next);
      if (workspace && detailId) {
        if (
          selected &&
          canAccessAdminPath(
            `/admin/orgs/${encodeURIComponent(selected.orgId)}`,
            isAdmin,
            selected,
            'workspace',
          )
        ) {
          void navigate({
            to: '/admin/orgs/$orgId',
            params: { orgId: selected.orgId },
            search: { view: 'workspace', orgId: selected.orgId },
          });
        } else {
          const target =
            selected && WORKSPACES.find((path) => canAccessAdminPath(path, isAdmin, selected));
          if (target && selected) {
            void navigate({ to: target, search: { orgId: selected.orgId } });
          } else if (isAdmin) {
            void navigate({ to: '/admin/orgs/$orgId', params: { orgId: detailId } });
          } else {
            void navigate({ to: '/admin/account' });
          }
        }
        return;
      }
      if (!scoped) return;
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, orgId: next }),
        replace: true,
      });
    },
    [detailId, isAdmin, memberships, navigate, orgId, scoped, workspace],
  );
  return {
    orgId,
    setOrgId,
    memberships,
    membership,
    hasExplicitOrg,
    requestedOrgId: fromUrl,
    // The URL/storage choice is useful for comparing scopes, but is never a grant.
    requestedSelection: requested,
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

/** Verify a resource's actual owner with fresh grants before adopting it into the URL. */
export function useResourceOrg(
  resourceOrgId: string | null | undefined,
  allowShared = false,
): 'pending' | 'ready' | 'not-found' | 'choose-org' {
  const scope = useOrgScope();
  const { pathname, workspace } = useScopeLocation();
  const { authed, isAdmin } = useSession();
  const userId = authed?.user.id;
  const client = useQueryClient();
  const shared = resourceOrgId === null && allowShared;
  const target = shared ? scope.orgId : (resourceOrgId ?? undefined);
  const key = JSON.stringify([
    [userId, pathname, workspace, resourceOrgId, target],
    [scope.hasExplicitOrg, scope.requestedOrgId],
  ]);
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
  const view = workspace ? 'workspace' : undefined;
  const allowed = Boolean(
    target &&
      fresh &&
      current &&
      canAccessAdminPath(pathname, isAdmin, fresh, view) &&
      canAccessAdminPath(pathname, isAdmin, current, view),
  );
  const conflict =
    scope.hasExplicitOrg && (!scope.requestedOrgId || scope.requestedOrgId !== target);

  useEffect(() => {
    if (!allowed || conflict || !target) return;
    if (!scope.hasExplicitOrg) scope.setOrgId(target);
    else if (scope.orgId === target) store(target);
  }, [allowed, conflict, scope.hasExplicitOrg, scope.orgId, scope.setOrgId, target]);

  if (scope.isLoading || resourceOrgId === undefined) return 'pending';
  if (scope.isError || (resourceOrgId === null && !allowShared) || conflict) return 'not-found';
  if (shared && !target && !scope.hasExplicitOrg) return 'choose-org';
  if (!checked) return 'pending';
  if (!allowed) return 'not-found';
  if (!scope.hasExplicitOrg || scope.orgId !== target) return 'pending';
  return 'ready';
}
