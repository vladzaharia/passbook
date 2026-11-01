import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

const KEY = 'wallet-org-filter';

function read(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    // Storage may be blocked; the scope then lasts for this page only.
    return undefined;
  }
}

interface OrgScopeValue {
  /** Selected org id, or undefined for all orgs. Pages pass it as `orgId` to list queries. */
  orgId: string | undefined;
  setOrgId: (orgId: string | undefined) => void;
}

const OrgScopeContext = createContext<OrgScopeValue | null>(null);

/** The top-bar scope: the only org control. Lists, overview, audit, wizards and footers read it. */
export function OrgScopeProvider({ children }: { children: ReactNode }) {
  const [orgId, setState] = useState<string | undefined>(read);
  const setOrgId = useCallback((next: string | undefined) => {
    setState(next);
    try {
      if (next) localStorage.setItem(KEY, next);
      else localStorage.removeItem(KEY);
    } catch {
      // See read().
    }
  }, []);
  const value = useMemo(() => ({ orgId, setOrgId }), [orgId, setOrgId]);
  return <OrgScopeContext.Provider value={value}>{children}</OrgScopeContext.Provider>;
}

export function useOrgScope(): OrgScopeValue {
  const ctx = useContext(OrgScopeContext);
  if (!ctx) throw new Error('useOrgScope needs OrgScopeProvider');
  return ctx;
}
