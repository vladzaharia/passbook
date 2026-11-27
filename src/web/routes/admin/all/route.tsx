import { createFileRoute, Navigate, Outlet, stripSearchParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { canUseAllScope, readablePassOrgs } from '../../../lib/org-lists.ts';
import { ALL, orgPath } from '../../../lib/scope.ts';
import { enterScope } from '../../../lib/scope-store.ts';
import { ErrorState } from '../../../ui/error-state.tsx';
import { useReachableScope } from '../../../ui/layout/scope-entry.ts';
import { SkeletonRows } from '../../../ui/skeleton.tsx';

/**
 * The All scope needs `passes:read` in two or more organizations. Below that it sends the
 * person to the one organization left, or to the chooser; the server decides each call.
 */
function AllScopeGate() {
  const scope = useOrgScope();
  const reachable = useReachableScope();
  const allowed = !scope.isLoading && !scope.isError && canUseAllScope(scope.memberships);
  useEffect(() => {
    if (allowed) enterScope(ALL);
  }, [allowed]);
  if (scope.isLoading) return <SkeletonRows label="Loading organization access" />;
  if (scope.isError) {
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  }
  if (!allowed) {
    // One readable organization left: its Passes. Otherwise a scope the person can open, else the chooser.
    const [only, ...more] = readablePassOrgs(scope.memberships);
    const to = only && more.length === 0 ? orgPath(only.orgId, '/passes') : reachable?.to;
    return <Navigate to={to ?? '/admin'} replace />;
  }
  return <Outlet />;
}

export const Route = createFileRoute('/admin/all')({
  search: { middlewares: [stripSearchParams<{ orgId?: string | undefined }>(['orgId'])] },
  component: AllScopeGate,
});
