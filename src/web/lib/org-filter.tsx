import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { isOrgScoped } from './nav.ts';
import { orgScopeSearchSchema } from './route-search.ts';

const KEY = 'wallet-org-filter';

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

function useScopeLocation() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const fromUrl = useRouterState({ select: (s) => urlOrgId(s.location.search) });
  return { pathname, scoped: isOrgScoped(pathname), fromUrl };
}

/**
 * The admin shell keeps the URL and the remembered scope in step: a scoped page's `orgId` is
 * remembered, and a scoped page without one gets the remembered scope written into its URL, so
 * the address always shows what the list shows. Only URL changes trigger it.
 */
export function useOrgScopeUrl(): void {
  const navigate = useNavigate();
  const { pathname, scoped, fromUrl } = useScopeLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname re-runs it on every page
  useEffect(() => {
    if (!scoped) return;
    if (fromUrl) {
      store(fromUrl);
      return;
    }
    const remembered = readStored();
    if (!remembered) return;
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, orgId: remembered }),
      replace: true,
      resetScroll: false,
      ignoreBlocker: true,
    });
  }, [pathname, scoped, fromUrl, navigate]);
}

interface OrgScopeValue {
  /** Selected org id, or undefined for all orgs. Pages pass it as `orgId` to list queries. */
  orgId: string | undefined;
  setOrgId: (orgId: string | undefined) => void;
}

/**
 * The top-bar scope, the only org control: `?orgId=` on scoped pages, the remembered scope
 * elsewhere (and until the URL catches up). The switcher, the palette and org links set it.
 */
export function useOrgScope(): OrgScopeValue {
  const navigate = useNavigate();
  const { scoped, fromUrl } = useScopeLocation();
  const remembered = useSyncExternalStore(subscribe, readStored, () => undefined);
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
