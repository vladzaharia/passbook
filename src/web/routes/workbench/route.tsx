import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { wbOrgOf, wbToolOf } from '@/shared/workbench.ts';
import { useSession } from '../../lib/session.ts';
import { StandaloneError } from '../../ui/layout/lazy-error-pages.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { useWorkbenchContexts } from '../../workbench/host/contexts.ts';
import { resetSessionGone } from '../../workbench/host/session-gone.ts';
import { forgetTokens } from '../../workbench/host/token.ts';
import { ToolHostProvider } from '../../workbench/host/tool-host.tsx';
import { PUBLIC_AREAS } from '../../workbench/shell/nav-model.ts';
import { WorkbenchShell } from '../../workbench/shell/workbench-shell.tsx';

// The states only some visits reach load with them (WB_SHELL_BUDGET).
const states = () => import('../../workbench/states/states.tsx');
const SignInState = lazy(() => states().then((m) => ({ default: m.SignInState })));
const ToolFailed = lazy(() => states().then((m) => ({ default: m.ToolFailed })));
const PolarisIdRequired = lazy(() =>
  import('../../ui/layout/polaris-id-required.tsx').then((m) => ({ default: m.PolarisIdRequired })),
);

/**
 * The Workbench's space (design §1.1): its own shell around every page. Signed out, Design and
 * Quickstart open and the rest show the one sign-in state; an email-link session waits for Polaris
 * ID. The context the path names gets its token host here, so the nav's attention reads it too.
 */
function WorkbenchLayout() {
  const { authed, isPending } = useSession();
  const location = useRouterState({ select: (s) => s.location });
  const contexts = useWorkbenchContexts();
  // PrincipalBoundary remounts the space for each person: no token or banner carries over.
  useEffect(() => {
    forgetTokens();
    resetSessionGone();
  }, []);

  const href = location.href;
  const tool = wbToolOf(location.pathname);
  const orgId = wbOrgOf(location.pathname);
  const list = contexts.data ?? [];
  // Quickstart lives outside any context path; it is the sandbox's.
  const context =
    (orgId
      ? list.find((c) => c.orgId === orgId)
      : tool === 'quickstart'
        ? list.find((c) => c.kind === 'sandbox')
        : undefined) ?? null;
  // Signed out, Design and Quickstart open; the sidebar's sign-in card shows there only, so a view
  // never carries two buddies or two sign-in buttons.
  const signedOutPublic = Boolean(tool && PUBLIC_AREAS.has(tool) && !orgId);
  let body = <Outlet />;
  if (isPending) body = <SkeletonRows label="Loading" />;
  // An email link opens the holder's spaces only: the Workbench waits for Polaris ID.
  else if (authed && authed.amr !== 'oidc')
    body = <PolarisIdRequired space="The Workbench" next={href} />;
  else if (!authed) {
    if (!signedOutPublic) body = <SignInState next={href} />;
  } else if (contexts.isPending) body = <SkeletonRows label="Loading" />;
  else if (contexts.isError)
    body = <ToolFailed error={contexts.error} onRetry={contexts.refetch} />;

  const shell = (
    <WorkbenchShell
      contexts={list}
      context={context}
      tool={tool}
      signedOutNext={authed || isPending || !signedOutPublic ? null : href}
    >
      <Suspense fallback={<SkeletonRows label="Loading" />}>{body}</Suspense>
    </WorkbenchShell>
  );
  return context ? <ToolHostProvider context={context}>{shell}</ToolHostProvider> : shell;
}

export const Route = createFileRoute('/workbench')({
  component: WorkbenchLayout,
  errorComponent: StandaloneError,
});
