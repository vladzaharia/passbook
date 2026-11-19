import { createFileRoute, Outlet, stripSearchParams, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { canAccessOrgSection } from '../../../../lib/guards.ts';
import { firstAllowedPath, sectionLabel } from '../../../../lib/nav.ts';
import { useOrgScope } from '../../../../lib/org-filter.tsx';
import { clearOrgPreviewBatches } from '../../../../lib/preview-batch.ts';
import { parseAdminPath } from '../../../../lib/scope.ts';
import { enterScope } from '../../../../lib/scope-store.ts';
import { useSession } from '../../../../lib/session.ts';
import { ErrorState } from '../../../../ui/error-state.tsx';
import { ScopedDeniedPage, ScopeRefusal } from '../../../../ui/layout/error-pages.tsx';
import { useReachableScope } from '../../../../ui/layout/scope-entry.ts';
import { SkeletonRows } from '../../../../ui/skeleton.tsx';

/** An organization's pages open only with an active membership in it; the server decides each call. */
function OrgScopeGate() {
  const { orgId } = Route.useParams();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const notFound = useRouterState({
    select: (state) =>
      state.matches.some((match) => match._notFound || match.status === 'notFound'),
  });
  const { rest } = parseAdminPath(pathname);
  const { isAdmin, authed } = useSession();
  const principalId = authed?.user.id;
  const scope = useOrgScope();
  const { membership } = scope;
  const allowed = Boolean(membership && canAccessOrgSection(rest, membership));
  const reachable = useReachableScope();

  // Only an already admitted wizard for this exact principal and organization keeps its draft
  // while grants load again; its own queries and create action still require fresh grants.
  const wizard = rest === '/passes/new';
  const admitted = useRef<string | undefined>(undefined);
  const admission = principalId ? `${principalId}:${orgId}` : undefined;
  useEffect(() => {
    if (wizard && allowed) admitted.current = admission;
    else if (!scope.isLoading || !wizard) admitted.current = undefined;
  }, [wizard, allowed, admission, scope.isLoading]);

  useEffect(() => {
    if (membership) enterScope({ kind: 'org', orgId: membership.orgId });
  }, [membership]);
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previous.current && previous.current !== orgId) clearOrgPreviewBatches(previous.current);
    previous.current = orgId;
  }, [orgId]);

  if (notFound) return <Outlet />;
  if (scope.isLoading) {
    return wizard && admitted.current === admission ? (
      <Outlet />
    ) : (
      <SkeletonRows label="Loading organization access" />
    );
  }
  if (scope.isError) {
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  }
  if (!membership) {
    return (
      <ScopeRefusal description="You are not a member of this organization." entry={reachable} />
    );
  }
  if (!allowed) {
    const to = firstAllowedPath({ kind: 'org', orgId }, isAdmin, membership);
    return (
      <ScopedDeniedPage
        orgName={membership.orgName}
        section={sectionLabel(pathname)}
        entry={to ? { to, label: sectionLabel(to) } : undefined}
      />
    );
  }
  return <Outlet />;
}

export const Route = createFileRoute('/admin/o/$orgId')({
  // The path names the organization; an old ?orgId= never rides along.
  search: { middlewares: [stripSearchParams<{ orgId?: string | undefined }>(['orgId'])] },
  component: OrgScopeGate,
});
