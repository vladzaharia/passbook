import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

const KEY = 'wallet-org-filter';

function read(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    // Storage may be blocked; the filter then lasts for this page only.
    return undefined;
  }
}

interface OrgFilterValue {
  /** Selected org id, or undefined for all orgs. Pages pass it as `orgId` to list queries. */
  orgId: string | undefined;
  setOrgId: (orgId: string | undefined) => void;
}

const OrgFilterContext = createContext<OrgFilterValue | null>(null);

export function OrgFilterProvider({ children }: { children: ReactNode }) {
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
  return <OrgFilterContext.Provider value={value}>{children}</OrgFilterContext.Provider>;
}

export function useOrgFilter(): OrgFilterValue {
  const ctx = useContext(OrgFilterContext);
  if (!ctx) throw new Error('useOrgFilter needs OrgFilterProvider');
  return ctx;
}
