import { createContext, type ReactNode, useContext, useEffect, useMemo } from 'react';
import { PATHS } from '@/shared/developers.ts';
import { useSession } from '../../lib/session.ts';
import { ToolScopeProvider } from '../../lib/tool-api.tsx';
import type { OperationsClient } from '../../ui/operation/client.ts';
import { createToolApi, type ToolApiDeps, type WorkbenchApi } from './api.ts';
import type { WbContext } from './contexts.ts';
import { createTestOperationsClient } from './operations.ts';
import { refusingApi } from './refusing.ts';
import { markSessionGone } from './session-gone.ts';
import { dropToken, dueIn, onTokenMinted, workbenchToken } from './token.ts';

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
  /** The activity tray's client: the same token. */
  operations: OperationsClient;
  links: { admin: string; docs: string };
}

const HostContext = createContext<ToolHost | null>(null);

/** Admin opens the same org in Test (it adopts `mode=test` once). */
export const adminLink = (orgId: string): string =>
  `/admin/o/${encodeURIComponent(orgId)}?mode=test`;

/**
 * Keeps the org's token fresh while the tab is visible: the server's lifetime, 12 minutes in. It
 * plans again after every mint, whoever made it, and when the tab becomes visible.
 */
function useRenewal(orgId: string | undefined, csrf: string | undefined) {
  useEffect(() => {
    if (!orgId || !csrf) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const plan = () => {
      clearTimeout(timer);
      const wait = dueIn(orgId);
      if (wait === null || document.visibilityState !== 'visible') return;
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible')
          void workbenchToken(orgId, csrf, true).catch(() => undefined);
      }, wait);
    };
    plan();
    const off = onTokenMinted(plan);
    document.addEventListener('visibilitychange', plan);
    return () => {
      clearTimeout(timer);
      off();
      document.removeEventListener('visibilitychange', plan);
    };
  }, [orgId, csrf]);
}

/**
 * Pins the one tool scope for every Workbench page (design §1.8, H2). With a context: its token
 * client and Test. Without one (the chooser, signed out): a client that refuses every call, still
 * Test, so a tool there can never reach the session client. The shell stays mounted as the context
 * changes: the provider never changes the tree's shape.
 */
export function ToolHostProvider({
  context,
  children,
}: {
  context: WbContext | null;
  children: ReactNode;
}) {
  const csrf = useSession().authed?.csrfToken;
  const orgId = context?.orgId;
  const value = useMemo<ToolHost | null>(() => {
    if (!context) return null;
    const deps: ToolApiDeps = {
      orgId: context.orgId,
      token: () => workbenchToken(context.orgId, csrf ?? ''),
      drop: (used) => dropToken(context.orgId, used),
      onSessionGone: markSessionGone,
    };
    return {
      context,
      mode: 'test',
      api: createToolApi(deps),
      operations: createTestOperationsClient(deps),
      links: { admin: adminLink(context.orgId), docs: PATHS.home },
    };
  }, [context, csrf]);
  useRenewal(orgId, csrf);
  return (
    <HostContext.Provider value={value}>
      <ToolScopeProvider
        api={value?.api ?? refusingApi}
        client={`workbench:${orgId ?? 'none'}`}
        mode="test"
        orgId={orgId}
      >
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
