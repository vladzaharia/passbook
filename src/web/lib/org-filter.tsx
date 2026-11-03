import {
  type ParsedLocation,
  redirect,
  stripSearchParams,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { useCallback, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { isOrgScoped } from './nav.ts';

const KEY = 'wallet-org-filter';

/** `?orgId=` on scoped admin pages: the admin route validates it, so every child route types it. */
export const orgScopeSearchSchema = z.object({
  orgId: z.string().min(1).max(100).optional().catch(undefined),
});

/** Routes the scope does not apply to (nav.ts orgScoped: false) drop `orgId` from their URL. */
export const UNSCOPED_SEARCH = {
  middlewares: [stripSearchParams<{ orgId?: string | undefined }>(['orgId'])],
};

const listeners = new Set<() => void>();

function readStored(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    // Storage may be blocked; the scope then lives in the URL only.
    return undefined;
  }
}

function store(orgId: string | undefined): void {
  if (orgId === readStored()) return;
  try {
    if (orgId) localStorage.setItem(KEY, orgId);
    else localStorage.removeItem(KEY);
  } catch {
    // See readStored().
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

const urlOrgId = (search: Record<string, unknown>) =>
  orgScopeSearchSchema.parse({ orgId: search.orgId }).orgId;

/**
 * Admin route beforeLoad: a scoped page's `orgId` is remembered, and a scoped page without one
 * gets the remembered scope written into its URL, so the address always shows what the list shows.
 */
export function seedOrgScope(location: ParsedLocation, preload: boolean): void {
  if (!isOrgScoped(location.pathname)) return;
  const fromUrl = urlOrgId(location.search);
  if (fromUrl) {
    if (!preload) store(fromUrl);
    return;
  }
  const remembered = readStored();
  if (!remembered) return;
  const params = new URLSearchParams(location.searchStr);
  params.set('orgId', remembered);
  throw redirect({
    href: `${location.pathname}?${params}${location.hash ? `#${location.hash}` : ''}`,
  });
}

interface OrgScopeValue {
  /** Selected org id, or undefined for all orgs. Pages pass it as `orgId` to list queries. */
  orgId: string | undefined;
  setOrgId: (orgId: string | undefined) => void;
}

/**
 * The top-bar scope, the only org control: `?orgId=` on scoped pages, the remembered scope
 * elsewhere. The switcher, the palette and org links set it.
 */
export function useOrgScope(): OrgScopeValue {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const fromUrl = useRouterState({ select: (s) => urlOrgId(s.location.search) });
  const remembered = useSyncExternalStore(subscribe, readStored, () => undefined);
  const scoped = isOrgScoped(pathname);
  const setOrgId = useCallback(
    (next: string | undefined) => {
      store(next);
      if (!scoped) return;
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, orgId: next }),
        replace: true,
      });
    },
    [navigate, scoped],
  );
  return { orgId: (scoped ? fromUrl : undefined) ?? remembered, setOrgId };
}
