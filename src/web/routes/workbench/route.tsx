import { createFileRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { lazy, type ReactNode, Suspense, useEffect } from 'react';
import { wbOrgOf, wbToolOf } from '@/shared/workbench.ts';
import { ApiError } from '../../lib/errors.ts';
import { useSession } from '../../lib/session.ts';
import { StandaloneError } from '../../ui/layout/lazy-error-pages.tsx';
import { SkeletonRows } from '../../ui/skeleton.tsx';
import { useWorkbenchContexts } from '../../workbench/host/contexts.ts';
import { markSessionGone, resetSessionGone } from '../../workbench/host/session-gone.ts';
import { forgetTokens } from '../../workbench/host/token.ts';
import { ToolHostProvider } from '../../workbench/host/tool-host.tsx';
import { PUBLIC_AREAS } from '../../workbench/shell/nav-model.ts';
import { setPerson } from '../../workbench/shell/person.ts';
import { WorkbenchShell } from '../../workbench/shell/workbench-shell.tsx';

// The states only some visits reach load with them (WB_SHELL_BUDGET).
const states = () => import('../../workbench/states/states.tsx');
const SignInState = lazy(() => states().then((m) => ({ default: m.SignInState })));
const ToolFailed = lazy(() => states().then((m) => ({ default: m.ToolFailed })));
const StaleContextsNotice = lazy(() =>
  import('../../workbench/shell/moments.tsx').then((m) => ({ default: m.StaleContextsNotice })),
);
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
  setPerson(authed?.user.id);
  // PrincipalBoundary remounts the space for each person: no token or banner carries over.
  useEffect(() => {
    forgetTokens();
    resetSessionGone();
  }, []);

  // The session ended behind a refetch: the "Sign in again" banner, never Retry.
  const ended = contexts.error instanceof ApiError && contexts.error.isUnauthorized;
  useEffect(() => {
    if (ended) markSessionGone();
  }, [ended]);
  // A fresh answer means the session is back (signed in again in another tab).
  const answeredAt = contexts.dataUpdatedAt;
  useEffect(() => {
    if (answeredAt > 0) resetSessionGone();
  }, [answeredAt]);

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
  // Signed out, Design and Quickstart open. Design carries the sidebar's sign-in card; Quickstart's step 1
  // is its own, so a view never carries two buddies or two sign-in buttons.
  const signedOutPublic = Boolean(tool && PUBLIC_AREAS.has(tool) && !orgId);
  // Quickstart words its own gate (step 1: Polaris ID, no developer access), so the shell states stand aside.
  const ownGate = tool === 'quickstart';
  let body: ReactNode = <Outlet />;
  if (isPending) body = <SkeletonRows label="Loading" />;
  // An email link opens the holder's spaces only: the Workbench waits for Polaris ID.
  else if (authed && authed.amr !== 'oidc' && !ownGate)
    body = <PolarisIdRequired space="The Workbench" next={href} />;
  else if (!authed) {
    if (!signedOutPublic) body = <SignInState next={href} />;
  } else if (contexts.isPending) body = <SkeletonRows label="Loading" />;
  // A failed refetch keeps the open tool (and its unsaved state); only a first load that failed replaces it.
  else if (contexts.isError && !contexts.data)
    body = ended ? null : <ToolFailed error={contexts.error} onRetry={contexts.refetch} />;

  const stale = contexts.isError && contexts.data !== undefined && !ended;
  // One tree whatever the context: it changes null <-> set <-> another without a remount.
  return (
    <ToolHostProvider context={context}>
      <WorkbenchShell
        contexts={list}
        context={context}
        tool={tool}
        signedOut={!authed && !isPending}
        signedOutNext={authed || isPending || !signedOutPublic || ownGate ? null : href}
      >
        {stale ? (
          <Suspense fallback={null}>
            <StaleContextsNotice onRetry={() => void contexts.refetch()} />
          </Suspense>
        ) : null}
        <Suspense fallback={<SkeletonRows label="Loading" />}>{body}</Suspense>
      </WorkbenchShell>
    </ToolHostProvider>
  );
}

export const Route = createFileRoute('/workbench')({
  component: WorkbenchLayout,
  errorComponent: StandaloneError,
});
