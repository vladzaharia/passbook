import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { wbToolOf } from '@/shared/workbench.ts';
import { useSession } from '../../../../lib/session.ts';
import {
  nearestTool,
  rememberContext,
  useWorkbenchContexts,
} from '../../../../workbench/host/contexts.ts';
import { ContextNotFound, ToolNotAllowed } from '../../../../workbench/states/states.tsx';

/**
 * A context's pages open only when it is one of this person's (`GET /workbench/contexts`) and the
 * area is allowed there; the server still decides every call. A refused area is absent from the
 * nav, so a deep link to it says why and offers the nearest one (design §6).
 */
function ContextGate() {
  const { orgId } = Route.useParams();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { authed } = useSession();
  const contexts = useWorkbenchContexts();
  const context = contexts.data?.find((c) => c.orgId === orgId);
  const userId = authed?.user.id;
  useEffect(() => {
    if (userId && context) rememberContext(userId, context.orgId);
  }, [userId, context]);
  // The layout holds loading, failure and signed-out states; here the list is in.
  if (!contexts.data) return null;
  if (!context) return <ContextNotFound />;
  const tool = wbToolOf(pathname) ?? 'home';
  if (!context.tools.includes(tool))
    return (
      <ToolNotAllowed
        orgId={context.orgId}
        orgName={context.name}
        nearest={nearestTool(tool, context.tools)}
      />
    );
  return <Outlet />;
}

export const Route = createFileRoute('/workbench/o/$orgId')({ component: ContextGate });
