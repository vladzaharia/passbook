import { createFileRoute, Outlet, stripSearchParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { PLATFORM } from '../../../lib/scope.ts';
import { enterScope } from '../../../lib/scope-store.ts';
import { useSession } from '../../../lib/session.ts';
import { ScopeRefusal } from '../../../ui/layout/error-pages.tsx';
import { useReachableScope } from '../../../ui/layout/scope-entry.ts';
import { SkeletonRows } from '../../../ui/skeleton.tsx';

/** Platform pages need platform rights; an organization admin gets a way to their organization. */
function PlatformScopeGate() {
  const { isAdmin } = useSession();
  const reachable = useReachableScope();
  const grants = useOrgScope();
  useEffect(() => {
    if (isAdmin) enterScope(PLATFORM);
  }, [isAdmin]);
  if (!isAdmin && grants.isLoading) return <SkeletonRows label="Loading organization access" />;
  if (!isAdmin) {
    return <ScopeRefusal description="Platform pages need a platform admin." entry={reachable} />;
  }
  return <Outlet />;
}

export const Route = createFileRoute('/admin/platform')({
  search: { middlewares: [stripSearchParams<{ orgId?: string | undefined }>(['orgId'])] },
  component: PlatformScopeGate,
});
