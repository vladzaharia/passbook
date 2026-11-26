import { useLocation, useRouter } from '@tanstack/react-router';
import { type ReactNode, useEffect, useLayoutEffect, useState } from 'react';
import type { WbTool } from '@/shared/workbench.ts';
import { BenchSkeleton } from '../bench/skeleton.tsx';
import { BenchState } from '../bench/state.tsx';
import { bindBenchRouter } from '../bench/url.ts';
import { loadSession, onSession, type Sandbox, type Session } from '../console/session.ts';
import { useOptionalToolHost } from '../host/tool-host.tsx';
import { ToolPage } from '../shell/tool-page.tsx';
import { NoSandboxState, SignInState, ToolFailed } from '../states/states.tsx';
import { ToolPlaceholder } from './placeholder.tsx';
import '../bench/bench.css';
import '../bench/pane.css';
import '../styles/legacy.css';

/**
 * The session the moved tools were written against: who is signed in and which sandbox they hold,
 * read once (console/session.ts) and kept current when a tool changes it. Null until read.
 */
export function useLegacySession(): Session | null {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    let live = true;
    void loadSession().then((s) => live && setSession(s));
    const off = onSession((s) => live && setSession(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return session;
}

/** Bench selections and filters write the address through the router, so Back and the shell keep in step. */
export function useBenchRouter(): void {
  const router = useRouter();
  useLayoutEffect(() => {
    bindBenchRouter((href) => router.history.replace(href));
    return () => bindBenchRouter(null);
  }, [router]);
}

export interface ReadySession {
  csrf: string;
  sandbox: Sandbox;
}

/**
 * A moved tool in its Workbench page: the tool head from `ToolPage`, the sandbox's session read for
 * it, and the one line for each way a sandbox may be absent. A tool runs on the sandbox only (the
 * moved code reads it); an org's Test keeps the placeholder until the tool is on the token client.
 */
export function LegacyTool({
  tool,
  className,
  closed,
  children,
}: {
  tool: WbTool;
  /** The route's own class (`wb-tool-<name>`): the bundle check finds the tool's chunk by it. */
  className: string;
  /** What a closed sandbox shows instead of the generic state (Home offers Reopen). */
  closed?: ReactNode;
  children: (session: ReadySession) => ReactNode;
}) {
  const host = useOptionalToolHost();
  const session = useLegacySession();
  const href = useLocation({ select: (l) => l.href });
  useBenchRouter();
  if (host?.context.kind !== 'sandbox') return <ToolPlaceholder tool={tool} />;
  let body: ReactNode;
  if (!session) body = <BenchSkeleton rows={6} />;
  else if (session.kind === 'out') body = <SignInState next={href} />;
  else if (session.kind === 'none') body = <NoSandboxState />;
  else if (session.kind === 'closed') body = closed ?? <BenchState scene="closed" />;
  else if (session.kind === 'failed')
    body = <ToolFailed error={new Error('sandbox')} onRetry={() => location.reload()} />;
  else body = children({ csrf: session.csrf, sandbox: session.sandbox });
  return (
    <ToolPage tool={tool}>
      <div className={`wb-legacy ${className}`}>{body}</div>
    </ToolPage>
  );
}
