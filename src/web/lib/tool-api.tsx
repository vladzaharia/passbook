import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import { api } from './api.ts';
import { useMode } from './mode.ts';

/** The client a shared tool calls through: the session's in admin, the Workbench token in the Workbench. */
export type ToolApi = Pick<
  typeof api,
  'get' | 'post' | 'put' | 'patch' | 'deleteJson' | 'delete' | 'action'
>;

/** What a host pins for the tools under it. */
export interface ToolScope {
  api: ToolApi;
  /** Which client answers, such as `workbench:<orgId>`: cached answers never cross clients. */
  client: string;
  /** The mode every call is in (keys and mode-scoped reads follow it). */
  mode: Mode;
  /** The organization the host acts in. */
  orgId: string | undefined;
}

const ToolScopeContext = createContext<ToolScope | null>(null);

/**
 * Pins the client, mode and organization for every tool below. Admin needs none: without a
 * provider, tools use the session client, the admin mode switch and the URL's organization.
 */
export function ToolScopeProvider({
  api: tool,
  client,
  mode,
  orgId,
  children,
}: ToolScope & { children: ReactNode }) {
  const value = useMemo(() => ({ api: tool, client, mode, orgId }), [tool, client, mode, orgId]);
  return <ToolScopeContext.Provider value={value}>{children}</ToolScopeContext.Provider>;
}

/** The pinned scope, or null in admin, where the URL and the mode switch decide. */
export function useToolScope(): ToolScope | null {
  return useContext(ToolScopeContext);
}

export function useToolApi(): ToolApi {
  return useContext(ToolScopeContext)?.api ?? api;
}

export function useToolMode(): Mode {
  const pinned = useContext(ToolScopeContext)?.mode;
  const switched = useMode();
  return pinned ?? switched;
}

const ADMIN_KEY: readonly string[] = [];

/**
 * Appended to every tool query key: the pinned client and mode. Admin's keys stay as they are
 * (its pages write them exactly); a pinned host's keys are longer, so the two never share an entry.
 */
export function useToolKey(): readonly string[] {
  const pinned = useContext(ToolScopeContext);
  return useMemo(() => (pinned ? [pinned.client, pinned.mode] : ADMIN_KEY), [pinned]);
}
