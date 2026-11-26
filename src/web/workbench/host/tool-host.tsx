import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react';
import { PATHS } from '@/shared/developers.ts';
import { useSession } from '../../lib/session.ts';
import { ToolScopeProvider } from '../../lib/tool-api.tsx';
import { createToolApi, type WorkbenchApi } from './api.ts';
import type { WbContext } from './contexts.ts';
import { markSessionGone } from './session-gone.ts';
import { dropToken, dueIn, workbenchToken } from './token.ts';

/**
 * What every Workbench tool builds on (design §1.8): the context it runs in, the token client
 * pinned to Test, and the links out. Shared tools reach the client through the one tool scope
 * (`lib/tool-api.tsx`: `useToolApi`, `useToolMode`), which this host pins; Workbench pages read the
 * rest through `useToolHost()`. Nothing in `workbench/**` imports `lib/api.ts` or `lib/mode.ts`.
 */
export interface ToolHost {
  context: WbContext;
  mode: 'test';
  api: WorkbenchApi;
  links: { admin: string; docs: string };
}

const HostContext = createContext<ToolHost | null>(null);

/** Admin opens the same org in Test (it adopts `mode=test` once). */
export const adminLink = (orgId: string): string =>
  `/admin/o/${encodeURIComponent(orgId)}?mode=test`;

/** Keeps the org's token fresh while the tab is visible: due at 12 minutes, renewed then. */
function useRenewal(orgId: string, csrf: string | undefined) {
  useEffect(() => {
    if (!csrf) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const plan = () => {
      clearTimeout(timer);
      const wait = dueIn(orgId);
      if (wait === null || document.visibilityState !== 'visible') return;
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible')
          void workbenchToken(orgId, csrf).then(plan, () => undefined);
      }, wait);
    };
    plan();
    document.addEventListener('visibilitychange', plan);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', plan);
    };
  }, [orgId, csrf]);
}

export function ToolHostProvider({
  context,
  children,
}: {
  context: WbContext;
  children: ReactNode;
}) {
  const csrf = useSession().authed?.csrfToken;
  const { orgId } = context;
  const value = useMemo<ToolHost>(
    () => ({
      context,
      mode: 'test',
      api: createToolApi({
        orgId,
        token: () => workbenchToken(orgId, csrf ?? ''),
        drop: () => dropToken(orgId),
        onSessionGone: markSessionGone,
      }),
      links: { admin: adminLink(orgId), docs: PATHS.home },
    }),
    [context, orgId, csrf],
  );
  useRenewal(orgId, csrf);
  return (
    <HostContext.Provider value={value}>
      <ToolScopeProvider api={value.api} mode="test" orgId={orgId}>
        {children}
      </ToolScopeProvider>
    </HostContext.Provider>
  );
}

/** The host a tool runs in, or null outside a context (signed out, the chooser). */
export function useOptionalToolHost(): ToolHost | null {
  return useContext(HostContext);
}

export function useToolHost(): ToolHost {
  const host = useContext(HostContext);
  if (!host) throw new Error('useToolHost outside a Workbench context.');
  return host;
}
