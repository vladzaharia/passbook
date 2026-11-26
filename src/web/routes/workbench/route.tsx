import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { wbOrgOf, wbToolOf } from '@/shared/workbench.ts';
import { useSession } from '../../lib/session.ts';
import { AppShell } from '../../ui/layout/app-shell.tsx';
import { StandaloneError } from '../../ui/layout/lazy-error-pages.tsx';
import { PolarisIdRequired } from '../../ui/layout/polaris-id-required.tsx';
import { PORTAL_BAR } from '../../ui/layout/portal-layout.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { useWorkbenchContexts } from '../../workbench/host/contexts.ts';
import { resetSessionGone } from '../../workbench/host/session-gone.ts';
import { forgetTokens } from '../../workbench/host/token.ts';
import { ToolHostProvider } from '../../workbench/host/tool-host.tsx';
import { PUBLIC_AREAS } from '../../workbench/shell/nav-model.ts';
import { WorkbenchShell } from '../../workbench/shell/workbench-shell.tsx';
import { SignInState, ToolFailed } from '../../workbench/states/states.tsx';

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
  if (authed && authed.amr !== 'oidc') {
    return (
      <AppShell bar={PORTAL_BAR} width="holder" holder>
        <PolarisIdRequired space="The Workbench" next={href} />
      </AppShell>
    );
  }
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
  let body = <Outlet />;
  if (isPending) body = <SkeletonRows label="Loading" />;
  else if (!authed) {
    if (!tool || !PUBLIC_AREAS.has(tool) || orgId) body = <SignInState next={href} />;
  } else if (contexts.isPending) body = <SkeletonRows label="Loading" />;
  else if (contexts.isError)
    body = <ToolFailed error={contexts.error} onRetry={contexts.refetch} />;

  const shell = (
    <WorkbenchShell
      contexts={list}
      context={context}
      tool={tool}
      signedOutNext={authed || isPending ? null : href}
    >
      {body}
    </WorkbenchShell>
  );
  return context ? <ToolHostProvider context={context}>{shell}</ToolHostProvider> : shell;
}

export const Route = createFileRoute('/workbench')({
  component: WorkbenchLayout,
  errorComponent: StandaloneError,
});
